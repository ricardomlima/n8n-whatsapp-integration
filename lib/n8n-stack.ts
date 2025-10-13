import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";

export interface N8nStackProps extends cdk.StackProps {
  environment: string;
  domain?: string;
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

    // Import hosted zone for domain
    const hostedZone = props.domain
      ? route53.HostedZone.fromLookup(this, "HostedZone", {
          domainName: props.domain,
        })
      : undefined;

    // Security Groups
    const albSg = new ec2.SecurityGroup(this, "ALBSecurityGroup", {
      vpc,
      description: "Security group for Application Load Balancer",
      allowAllOutbound: true,
    });

    const databaseSg = new ec2.SecurityGroup(this, "n8nDatabaseSg", {
      vpc,
      description: "Security group for RDS database",
      allowAllOutbound: false,
    });

    const redisSg = new ec2.SecurityGroup(this, "n8nRedisSg", {
      vpc,
      description: "Security group for Redis cache",
      allowAllOutbound: false,
    });

    const applicationSg = new ec2.SecurityGroup(this, "n8nApplicationSg", {
      vpc,
      description: "Security group for ECS application",
      allowAllOutbound: true,
    });

    // Security group rules
    // ALB accepts HTTP traffic from internet
    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP from internet"
    );

    // Application accepts traffic from ALB only
    applicationSg.addIngressRule(
      albSg,
      ec2.Port.tcp(5678),
      "Allow n8n from ALB"
    );

    // Database accepts traffic from application only
    databaseSg.addIngressRule(
      applicationSg,
      ec2.Port.tcp(5432),
      "Allow PostgreSQL from application"
    );

    // Redis accepts traffic from application only
    redisSg.addIngressRule(
      applicationSg,
      ec2.Port.tcp(6379),
      "Allow Redis from application"
    );

    // Secrets
    const dbSecret = new secretsmanager.Secret(this, "n8nDatabaseSecret", {
      description: "Database credentials for n8n",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "postgres" }),
        generateStringKey: "password",
        excludeCharacters: '"@/\\',
        passwordLength: 32,
      },
    });

    const n8nSecret = new secretsmanager.Secret(this, "n8nSecret", {
      description: "n8n API key and secrets",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apikey: "n8n_api_key" }),
        generateStringKey: "apikey",
        excludeCharacters: '"@/\\',
        passwordLength: 32,
      },
    });

    // Aurora Database Cluster

    // Aurora PostgreSQL Cluster
    const database = new rds.DatabaseCluster(this, "n8nAuroraCluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_3,
      }),
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: "n8n",
      vpc,
      vpcSubnets: {
        subnets: [privateSubnetA, privateSubnetB],
      },
      securityGroups: [databaseSg],
      backup: {
        retention: cdk.Duration.days(1), // Minimal for PoC
      },
      deletionProtection: false, // Allow easy cleanup for PoC
      storageEncrypted: true,
      cloudwatchLogsExports: props.enableLogging ? ["postgresql"] : [],
      monitoringInterval:
        props.environment !== "development"
          ? cdk.Duration.minutes(1)
          : undefined,
      writer: rds.ClusterInstance.serverlessV2("writer", {
        scaleWithWriter: true,
      }),
      readers:
        props.environment === "production" && props.enableMultiAz
          ? [
              rds.ClusterInstance.serverlessV2("reader", {
                scaleWithWriter: true,
              }),
            ]
          : [],
      serverlessV2MinCapacity: 0.5, // Same for all environments
      serverlessV2MaxCapacity: props.environment === "development" ? 1 : 4,
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
        subnets: [publicSubnetA, publicSubnetB], // ALB in public subnets
      },
    });

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
      retention: logs.RetentionDays.ONE_WEEK, // Shorter for PoC
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Grant task execution role access to log group
    logGroup.grantWrite(taskExecutionRole);

    // Task Definition (reduced resources for PoC)
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "N8nTaskDefinition",
      {
        memoryLimitMiB: 1024, // Reduced from 2048
        cpu: 512, // Reduced from 1024
        executionRole: taskExecutionRole,
        taskRole: taskRole,
      }
    );

    // n8n Container
    const n8nContainer = taskDefinition.addContainer("n8n", {
      image: ecs.ContainerImage.fromRegistry("docker.n8n.io/n8nio/n8n:latest"),
      memoryLimitMiB: 1024, // Reduced from 2048
      environment: {
        GENERIC_TIMEZONE: "America/Sao_Paulo",
        TZ: "America/Sao_Paulo",
        N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true",
        N8N_RUNNERS_ENABLED: "true",
        DB_TYPE: "postgresdb",
        DB_POSTGRESDB_HOST: database.clusterEndpoint.hostname,
        DB_POSTGRESDB_PORT: "5432",
        DB_POSTGRESDB_DATABASE: "n8n",
        DB_POSTGRESDB_SCHEMA: "public",
        N8N_HOST: "0.0.0.0",
        N8N_PORT: "5678",
        N8N_PROTOCOL: "http", // Simplified for PoC
        NODE_ENV: props.environment,
        QUEUE_BULL_REDIS_HOST: redisCluster.attrRedisEndpointAddress,
        QUEUE_BULL_REDIS_PORT: "6379",
        WEBHOOK_URL: props.domain
          ? `http://n8n.${props.domain}/webhook`
          : `http://${this.alb.loadBalancerDnsName}/webhook`,
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

    // ECS Service (NAT Gateway approach - private subnets)
    this.service = new ecs.FargateService(this, "N8nService", {
      cluster,
      taskDefinition,
      desiredCount: props.desiredCount,
      assignPublicIp: false, // ← No public IP needed with NAT Gateway
      securityGroups: [applicationSg],
      vpcSubnets: {
        subnets: [privateSubnetA, privateSubnetB], // ← Private subnets with NAT Gateway
      },
    });

    // Target Group for ALB
    this.targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "N8nTargetGroup",
      {
        vpc,
        port: 5678,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          enabled: true,
          path: "/healthz",
          protocol: elbv2.Protocol.HTTP,
          port: "5678",
          healthyHttpCodes: "200",
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          unhealthyThresholdCount: 3,
          healthyThresholdCount: 2,
        },
      }
    );

    // Register ECS service with target group
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // ALB Listener
    this.alb.addListener("N8nListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [this.targetGroup],
    });

    // Route 53 Alias Record (if domain provided)
    if (hostedZone && props.domain) {
      new route53.ARecord(this, "N8nAliasRecord", {
        zone: hostedZone,
        recordName: "n8n",
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(this.alb)
        ),
        comment: "n8n application via Application Load Balancer",
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: this.alb.loadBalancerDnsName,
      description: "Application Load Balancer DNS Name",
    });

    new cdk.CfnOutput(this, "N8nServiceName", {
      value: this.service.serviceName,
      description: "n8n ECS Service Name",
    });

    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: database.clusterEndpoint.hostname,
      description: "Aurora Database Endpoint",
    });

    new cdk.CfnOutput(this, "RedisEndpoint", {
      value: redisCluster.attrRedisEndpointAddress,
      description: "Redis Cache Endpoint",
    });

    if (props.domain) {
      new cdk.CfnOutput(this, "ApplicationURL", {
        value: `http://n8n.${props.domain}`,
        description: "n8n Application URL",
      });
    }

    new cdk.CfnOutput(this, "DirectALBAccess", {
      value: `http://${this.alb.loadBalancerDnsName}`,
      description: "Direct ALB Access (backup if DNS not working)",
    });

    new cdk.CfnOutput(this, "Instructions", {
      value: props.domain
        ? `🚀 Automatic DNS! Access n8n at: http://n8n.${props.domain} (user: admin, password: check Secrets Manager)`
        : `Access n8n at: http://${this.alb.loadBalancerDnsName} (user: admin, password: check Secrets Manager)`,
      description: "Access Instructions",
    });

    new cdk.CfnOutput(this, "LoginCredentials", {
      value:
        "Username: admin | Password: Check AWS Secrets Manager for 'n8nDatabaseSecret'",
      description: "n8n Login Credentials",
    });
  }
}
