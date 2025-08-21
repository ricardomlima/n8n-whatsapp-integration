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

export interface N8nStackProps extends cdk.StackProps {
  environment: string;
  domain?: string;
  certificateArn?: string;
  desiredCount: number;
  enableLogging: boolean;
  instanceClass: string;
  enableBackup: boolean;
  enableMultiAz: boolean;
}

export class N8nStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: N8nStackProps) {
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
      ec2.Port.tcp(5678),
      "Allow n8n from ALB"
    );

    // Secrets
    const dbSecret = new secretsmanager.Secret(this, "DatabaseSecret", {
      description: "Database credentials for n8n",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "postgres" }),
        generateStringKey: "password",
        excludeCharacters: '"@/\\',
        passwordLength: 32,
      },
    });

    const n8nSecret = new secretsmanager.Secret(this, "N8nSecret", {
      description: "n8n API key and secrets",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apikey: "n8n_api_key" }),
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
      databaseName: "n8n",
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
    this.alb = new elbv2.ApplicationLoadBalancer(this, "N8nALB", {
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
    const cluster = new ecs.Cluster(this, "N8nCluster", {
      vpc,
      containerInsights: props.enableLogging,
    });

    // Task Role
    const taskRole = new iam.Role(this, "N8nTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Task Execution Role
    const taskExecutionRole = new iam.Role(this, "N8nTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // Grant task execution role access to secrets
    dbSecret.grantRead(taskExecutionRole);
    n8nSecret.grantRead(taskExecutionRole);

    // Log Group
    const logGroup = new logs.LogGroup(this, "N8nLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Grant task execution role access to log group
    logGroup.grantWrite(taskExecutionRole);

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "N8nTaskDefinition",
      {
        memoryLimitMiB: 2048,
        cpu: 1024,
        executionRole: taskExecutionRole,
        taskRole: taskRole,
      }
    );

    // n8n Container
    const n8nContainer = taskDefinition.addContainer("n8n", {
      image: ecs.ContainerImage.fromRegistry("docker.n8n.io/n8nio/n8n:latest"),
      memoryLimitMiB: 2048,
      environment: {
        GENERIC_TIMEZONE: "America/Sao_Paulo",
        TZ: "America/Sao_Paulo",
        N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true",
        N8N_RUNNERS_ENABLED: "true",
        DB_TYPE: "postgresdb",
        DB_POSTGRESDB_HOST: database.instanceEndpoint.hostname,
        DB_POSTGRESDB_PORT: "5432",
        DB_POSTGRESDB_DATABASE: "n8n",
        DB_POSTGRESDB_SCHEMA: "public",
        N8N_HOST: "0.0.0.0",
        N8N_PORT: "5678",
        N8N_PROTOCOL: props.certificateArn ? "https" : "http",
        NODE_ENV: props.environment,
        QUEUE_BULL_REDIS_HOST: redisCluster.attrRedisEndpointAddress,
        QUEUE_BULL_REDIS_PORT: "6379",
        WEBHOOK_URL: props.domain
          ? `https://n8n.${props.domain}/webhook`
          : "http://localhost:5678/webhook",
        N8N_CORS_ORIGIN: "*",
        N8N_BASIC_AUTH_ACTIVE: "true",
        N8N_BASIC_AUTH_USER: "admin",
      },
      secrets: {
        DB_POSTGRESDB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DB_POSTGRESDB_PASSWORD: ecs.Secret.fromSecretsManager(
          dbSecret,
          "password"
        ),
        N8N_BASIC_AUTH_PASSWORD: ecs.Secret.fromSecretsManager(
          dbSecret,
          "password"
        ),
        N8N_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(n8nSecret, "apikey"),
      },
      logging: new ecs.AwsLogDriver({
        logGroup: logGroup,
        streamPrefix: "n8n",
      }),
    });

    n8nContainer.addPortMappings({
      containerPort: 5678,
      protocol: ecs.Protocol.TCP,
    });

    // ECS Service
    this.service = new ecs.FargateService(this, "N8nService", {
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
      "N8nTargetGroup",
      {
        vpc,
        port: 5678,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: "/healthz",
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

    mainListener.addAction("N8nAction", {
      priority: 100,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([`n8n.${props.domain}`]),
      ],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // Route 53 Record for n8n subdomain
    if (props.domain) {
      new route53.ARecord(this, "N8nSubdomainRecord", {
        zone: hostedZone,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(this.alb)
        ),
        recordName: `n8n.${props.domain}`,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "N8nUrl", {
      value: props.domain
        ? `https://n8n.${props.domain}`
        : `http://${this.alb.loadBalancerDnsName}`,
      description: "n8n URL",
    });

    new cdk.CfnOutput(this, "N8nServiceName", {
      value: this.service.serviceName,
      exportName: `${props.environment}-N8nServiceName`,
    });

    new cdk.CfnOutput(this, "N8nALBDnsName", {
      value: this.alb.loadBalancerDnsName,
      exportName: `${props.environment}-N8nALBDnsName`,
    });
  }
}
