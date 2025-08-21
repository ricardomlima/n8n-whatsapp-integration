import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import { Construct } from "constructs";

export interface EvolutionApiStackProps extends cdk.StackProps {
  environment: string;
  domain?: string;
  certificateArn?: string;
  desiredCount: number;
  enableLogging: boolean;
  instanceClass: string;
  enableBackup: boolean;
  enableMultiAz: boolean;
}

export class EvolutionApiStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: EvolutionApiStackProps) {
    super(scope, id, props);

    // Import VPC from another stack
    const vpc = ec2.Vpc.fromVpcAttributes(this, "ImportedVpc", {
      vpcId: cdk.Fn.importValue("AvaeranVpcId"),
      availabilityZones: ["us-east-1a", "us-east-1b"],
    });

    // Import subnets from another stack
    const publicSubnetA = ec2.Subnet.fromSubnetId(
      this,
      "PublicSubnetA",
      cdk.Fn.importValue("AvaeranPublicSubnetAId")
    );
    const publicSubnetB = ec2.Subnet.fromSubnetId(
      this,
      "PublicSubnetB",
      cdk.Fn.importValue("AvaeranPublicSubnetBId")
    );
    const privateSubnetA = ec2.Subnet.fromSubnetId(
      this,
      "PrivateSubnetA",
      cdk.Fn.importValue("AvaeranPrivateSubnetAId")
    );
    const privateSubnetB = ec2.Subnet.fromSubnetId(
      this,
      "PrivateSubnetB",
      cdk.Fn.importValue("AvaeranPrivateSubnetBId")
    );

    // Import hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.domain || "avaeran.com",
    });

    // Security Groups
    const databaseSg = new ec2.SecurityGroup(this, "DatabaseSg", {
      vpc,
      description: "Security group for RDS database",
      allowAllOutbound: false,
    });

    const redisSg = new ec2.SecurityGroup(this, "RedisSg", {
      vpc,
      description: "Security group for Redis cache",
      allowAllOutbound: false,
    });

    const applicationSg = new ec2.SecurityGroup(this, "ApplicationSg", {
      vpc,
      description: "Security group for ECS application",
      allowAllOutbound: true,
    });

    const albSg = new ec2.SecurityGroup(this, "ALBSg", {
      vpc,
      description: "Security group for Application Load Balancer",
      allowAllOutbound: true,
    });

    // Security group rules
    databaseSg.addIngressRule(
      applicationSg,
      ec2.Port.tcp(5432),
      "Allow PostgreSQL from application"
    );

    redisSg.addIngressRule(
      applicationSg,
      ec2.Port.tcp(6379),
      "Allow Redis from application"
    );

    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Allow HTTP");
    if (props.certificateArn) {
      albSg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443),
        "Allow HTTPS"
      );
    }

    applicationSg.addIngressRule(
      albSg,
      ec2.Port.tcp(8080),
      "Allow Evolution API from ALB"
    );

    // Secrets
    const dbSecret = new secretsmanager.Secret(this, "DatabaseSecret", {
      description: "Database credentials for Evolution API",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "postgres" }),
        generateStringKey: "password",
        excludeCharacters: '"@/\\',
        passwordLength: 32,
      },
    });

    const evolutionSecret = new secretsmanager.Secret(this, "EvolutionSecret", {
      description: "Evolution API key and secrets",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apikey: "evolution_api_key" }),
        generateStringKey: "apikey",
        excludeCharacters: '"@/\\',
        passwordLength: 32,
      },
    });

    // RDS Database
    const dbSubnetGroup = new rds.SubnetGroup(this, "DatabaseSubnetGroup", {
      vpc,
      description: "Subnet group for RDS database",
      vpcSubnets: {
        subnets: [privateSubnetA, privateSubnetB],
      },
    });

    const database = new rds.DatabaseInstance(this, "PostgreSQLDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        props.instanceClass.split(".")[1] as ec2.InstanceSize
      ),
      vpc,
      subnetGroup: dbSubnetGroup,
      securityGroups: [databaseSg],
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "evolution",
      backupRetention: props.enableBackup
        ? cdk.Duration.days(7)
        : cdk.Duration.days(0),
      deleteAutomatedBackups: !props.enableBackup,
      deletionProtection: props.environment === "production",
      multiAz: props.enableMultiAz || false,
      storageEncrypted: true,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      enablePerformanceInsights: props.environment !== "development",
    });

    // Redis Subnet Group
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "RedisSubnetGroup",
      {
        description: "Subnet group for Redis cache",
        subnetIds: [privateSubnetA.subnetId, privateSubnetB.subnetId],
      }
    );

    // Redis Cache
    const redisCluster = new elasticache.CfnCacheCluster(this, "RedisCache", {
      cacheNodeType: "cache.t3.micro",
      engine: "redis",
      numCacheNodes: 1,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      cacheSubnetGroupName: redisSubnetGroup.ref,
      engineVersion: "7.0",
      port: 6379,
    });

    // Application Load Balancer
    this.alb = new elbv2.ApplicationLoadBalancer(this, "EvolutionALB", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: {
        subnets: [publicSubnetA, publicSubnetB],
      },
    });

    // ALB Listeners
    let httpsListener: elbv2.ApplicationListener | undefined;
    let httpListener: elbv2.ApplicationListener;

    if (props.certificateArn) {
      httpsListener = this.alb.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: "text/plain",
          messageBody: "Not Found",
        }),
      });

      // HTTP listener redirects to HTTPS
      httpListener = this.alb.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
    } else {
      httpListener = this.alb.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: "text/plain",
          messageBody: "Not Found",
        }),
      });
    }

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "EvolutionCluster", {
      vpc,
      containerInsights: props.enableLogging,
    });

    // Task Role
    const taskRole = new iam.Role(this, "EvolutionTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Task Execution Role
    const taskExecutionRole = new iam.Role(this, "EvolutionTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // Grant task execution role access to secrets
    dbSecret.grantRead(taskExecutionRole);
    evolutionSecret.grantRead(taskExecutionRole);

    // Log Group
    const logGroup = new logs.LogGroup(this, "EvolutionLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Grant task execution role access to log group
    logGroup.grantWrite(taskExecutionRole);

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "EvolutionTaskDefinition",
      {
        memoryLimitMiB: 2048,
        cpu: 1024,
        executionRole: taskExecutionRole,
        taskRole: taskRole,
      }
    );

    // Evolution API Container
    const evolutionContainer = taskDefinition.addContainer("evolution-api", {
      image: ecs.ContainerImage.fromRegistry("atendai/evolution-api:v2.1.1"),
      memoryLimitMiB: 2048,
      environment: {
        SERVER_URL: props.domain
          ? `https://evolution.${props.domain}`
          : "http://localhost:8080",
        DEL_INSTANCE: "false",
        DATABASE_ENABLED: "true",
        DATABASE_PROVIDER: "postgresql",
        DATABASE_SAVE_DATA_INSTANCE: "true",
        DATABASE_SAVE_DATA_NEW_MESSAGE: "true",
        DATABASE_SAVE_MESSAGE_UPDATE: "true",
        DATABASE_SAVE_DATA_CONTACTS: "true",
        DATABASE_SAVE_DATA_CHATS: "true",
        DATABASE_SAVE_DATA_LABELS: "true",
        DATABASE_SAVE_DATA_HISTORIC: "true",
        DATABASE_CONNECTION_CLIENT_NAME: "evolution_v2",
        RABBITMQ_ENABLED: "false",
        CACHE_REDIS_ENABLED: "true",
        CACHE_REDIS_URI: `redis://${redisCluster.attrRedisEndpointAddress}:6379/1`,
        CACHE_REDIS_PREFIX_KEY: "evolution_v2",
        CACHE_REDIS_SAVE_INSTANCES: "false",
        CACHE_LOCAL_ENABLED: "false",
        // Note: Evolution API will run independently, no webhook to n8n
        WEBHOOK_URL: props.domain
          ? `https://webhooks.${props.domain}/evolution`
          : "http://localhost:8080/webhook",
        WEBHOOK_BY_EVENTS: "true",
        WEBHOOK_BASE64: "false",
        CONFIG_SESSION_PHONE_CLIENT: "Evolution API",
        CONFIG_SESSION_PHONE_NAME: "Chrome",
        CORS_ORIGIN: "*",
        CORS_METHODS: "GET,PUT,POST,DELETE,OPTIONS",
        CORS_CREDENTIALS: "true",
      },
      secrets: {
        DATABASE_CONNECTION_URI: ecs.Secret.fromSecretsManager(dbSecret),
        AUTHENTICATION_API_KEY: ecs.Secret.fromSecretsManager(
          evolutionSecret,
          "apikey"
        ),
      },
      logging: new ecs.AwsLogDriver({
        logGroup: logGroup,
        streamPrefix: "evolution-api",
      }),
    });

    evolutionContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    // ECS Service
    this.service = new ecs.FargateService(this, "EvolutionService", {
      cluster,
      taskDefinition,
      desiredCount: props.desiredCount,
      assignPublicIp: false,
      securityGroups: [applicationSg],
      vpcSubnets: {
        subnets: [privateSubnetA, privateSubnetB],
      },
    });

    // Target Group
    this.targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "EvolutionTargetGroup",
      {
        vpc,
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: "/",
          healthyHttpCodes: "200",
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      }
    );

    // Register service with target group
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // Add listener rules
    const mainListener = httpsListener || httpListener;

    mainListener.addAction("EvolutionAction", {
      priority: 100,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([`evolution.${props.domain}`]),
      ],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // Route 53 Record for Evolution API subdomain
    if (props.domain) {
      new route53.ARecord(this, "EvolutionSubdomainRecord", {
        zone: hostedZone,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(this.alb)
        ),
        recordName: `evolution.${props.domain}`,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "EvolutionApiUrl", {
      value: props.domain
        ? `https://evolution.${props.domain}`
        : `http://${this.alb.loadBalancerDnsName}`,
      description: "Evolution API URL",
    });

    new cdk.CfnOutput(this, "EvolutionServiceName", {
      value: this.service.serviceName,
      exportName: `${props.environment}-EvolutionServiceName`,
    });

    new cdk.CfnOutput(this, "EvolutionALBDnsName", {
      value: this.alb.loadBalancerDnsName,
      exportName: `${props.environment}-EvolutionALBDnsName`,
    });
  }
}
