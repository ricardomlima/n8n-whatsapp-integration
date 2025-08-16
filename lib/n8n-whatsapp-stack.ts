import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";

export interface N8nWhatsappStackProps extends cdk.StackProps {
  environment: string;
  domain?: string;
  certificateArn?: string;
  instanceClass: string;
  instanceType: string;
  desiredCount: number;
  enableLogging: boolean;
  enableBackup: boolean;
  enableMultiAz?: boolean;
}

export class N8nWhatsappStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: N8nWhatsappStackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new ec2.Vpc(this, "N8nWhatsappVpc", {
      maxAzs: props.enableMultiAz ? 3 : 2,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Security Groups
    const databaseSg = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
      description: "Security group for RDS database",
      allowAllOutbound: false,
    });

    const redisSg = new ec2.SecurityGroup(this, "RedisSecurityGroup", {
      vpc,
      description: "Security group for Redis cache",
      allowAllOutbound: false,
    });

    const applicationSg = new ec2.SecurityGroup(
      this,
      "ApplicationSecurityGroup",
      {
        vpc,
        description: "Security group for application services",
        allowAllOutbound: true,
      }
    );

    const albSg = new ec2.SecurityGroup(this, "ALBSecurityGroup", {
      vpc,
      description: "Security group for Application Load Balancer",
      allowAllOutbound: false,
    });

    // Security Group Rules
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
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Allow HTTPS");
    applicationSg.addIngressRule(
      albSg,
      ec2.Port.tcp(5678),
      "Allow n8n from ALB"
    );
    applicationSg.addIngressRule(
      albSg,
      ec2.Port.tcp(8080),
      "Allow Evolution API from ALB"
    );

    // Database Subnet Group
    const dbSubnetGroup = new rds.SubnetGroup(this, "DatabaseSubnetGroup", {
      vpc,
      description: "Subnet group for RDS database",
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // Database Secrets
    const dbSecret = new secretsmanager.Secret(this, "DatabaseSecret", {
      description: "Database credentials for n8n and Evolution API",
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
      enablePerformanceInsights: props.environment !== "dev",
    });

    // Redis Subnet Group
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "RedisSubnetGroup",
      {
        description: "Subnet group for Redis cache",
        subnetIds: vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
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

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "N8nWhatsappCluster", {
      vpc,
      containerInsights: props.enableLogging,
    });

    // Task Execution Role
    const taskExecutionRole = new iam.Role(this, "TaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // Task Role
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Grant secret access
    dbSecret.grantRead(taskExecutionRole);
    evolutionSecret.grantRead(taskExecutionRole);

    // Log Groups
    const n8nLogGroup = new logs.LogGroup(this, "N8nLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const evolutionLogGroup = new logs.LogGroup(this, "EvolutionLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "N8nWhatsappTaskDefinition",
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
      memoryLimitMiB: 1024,
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
          ? `https://${props.domain}/webhook`
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
        N8N_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(
          evolutionSecret,
          "apikey"
        ),
      },
      logging: new ecs.AwsLogDriver({
        logGroup: n8nLogGroup,
        streamPrefix: "n8n",
      }),
    });

    n8nContainer.addPortMappings({
      containerPort: 5678,
      protocol: ecs.Protocol.TCP,
    });

    // Evolution API Container
    const evolutionContainer = taskDefinition.addContainer("evolution-api", {
      image: ecs.ContainerImage.fromRegistry("atendai/evolution-api:v2.1.1"),
      memoryLimitMiB: 1024,
      environment: {
        SERVER_URL: props.domain
          ? `https://${props.domain}/evolution`
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
        WEBHOOK_URL: props.domain
          ? `https://${props.domain}/webhook`
          : "http://n8n:5678/webhook",
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
        logGroup: evolutionLogGroup,
        streamPrefix: "evolution-api",
      }),
    });

    evolutionContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    // ECS Service
    const service = new ecs.FargateService(this, "N8nWhatsappService", {
      cluster,
      taskDefinition,
      desiredCount: props.desiredCount,
      assignPublicIp: false,
      securityGroups: [applicationSg],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, "N8nWhatsappALB", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    // Target Groups
    const n8nTargetGroup = new elbv2.ApplicationTargetGroup(
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

    const evolutionTargetGroup = new elbv2.ApplicationTargetGroup(
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

    // Register targets
    service.attachToApplicationTargetGroup(n8nTargetGroup);
    service.attachToApplicationTargetGroup(evolutionTargetGroup);

    // Listeners
    if (props.certificateArn) {
      // HTTPS Listener
      const httpsListener = alb.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
        defaultAction: elbv2.ListenerAction.forward([n8nTargetGroup]),
      });

      httpsListener.addAction("EvolutionAction", {
        priority: 100,
        conditions: [elbv2.ListenerCondition.pathPatterns(["/evolution/*"])],
        action: elbv2.ListenerAction.forward([evolutionTargetGroup]),
      });

      // HTTP Redirect
      alb.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
    } else {
      // HTTP Only (for dev environment)
      const httpListener = alb.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.forward([n8nTargetGroup]),
      });

      httpListener.addAction("EvolutionAction", {
        priority: 100,
        conditions: [elbv2.ListenerCondition.pathPatterns(["/evolution/*"])],
        action: elbv2.ListenerAction.forward([evolutionTargetGroup]),
      });
    }

    // Route 53 (if domain is provided)
    if (props.domain) {
      const zone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: props.domain,
      });

      new route53.ARecord(this, "ALBAliasRecord", {
        zone,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(alb)
        ),
        recordName: props.domain,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: alb.loadBalancerDnsName,
      description: "Load Balancer DNS Name",
    });

    new cdk.CfnOutput(this, "N8nUrl", {
      value: props.domain
        ? `https://${props.domain}`
        : `http://${alb.loadBalancerDnsName}`,
      description: "n8n URL",
    });

    new cdk.CfnOutput(this, "EvolutionApiUrl", {
      value: props.domain
        ? `https://${props.domain}/evolution`
        : `http://${alb.loadBalancerDnsName}:8080`,
      description: "Evolution API URL",
    });
  }
}
