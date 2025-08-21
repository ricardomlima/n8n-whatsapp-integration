import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { SharedInfrastructureStack } from "../lib/shared-infrastructure-stack";
import { N8nStack } from "../lib/n8n-stack";
import { EvolutionApiStack } from "../lib/evolution-api-stack";

describe("N8n WhatsApp Integration Stacks", () => {
  let app: cdk.App;
  let sharedInfraStack: SharedInfrastructureStack;

  beforeEach(() => {
    app = new cdk.App();
    sharedInfraStack = new SharedInfrastructureStack(
      app,
      "TestSharedInfraStack",
      {
        environment: "dev",
        domain: "example.com",
        instanceClass: "db.t3.micro",
        enableBackup: false,
        enableMultiAz: false,
      }
    );
  });

  test("Shared Infrastructure Stack creates expected resources", () => {
    const template = Template.fromStack(sharedInfraStack);

    // Test that RDS instance is created
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      DBInstanceClass: "db.t3.micro",
    });

    // Test that ALB is created
    template.hasResourceProperties(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      {
        Type: "application",
        Scheme: "internet-facing",
      }
    );

    // Test that Redis cache is created
    template.hasResourceProperties("AWS::ElastiCache::CacheCluster", {
      Engine: "redis",
    });
  });

  test("N8n Stack creates expected resources", () => {
    const n8nStack = new N8nStack(app, "TestN8nStack", {
      environment: "dev",
      domain: "example.com",
      desiredCount: 1,
      enableLogging: true,
      sharedInfrastructure: sharedInfraStack,
    });

    const template = Template.fromStack(n8nStack);

    // Test that ECS cluster is created
    template.hasResourceProperties("AWS::ECS::Cluster", {});

    // Test that ECS service is created
    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
    });

    // Test that target group is created
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      Port: 5678,
      Protocol: "HTTP",
    });

    // Test that Route53 record is created for n8n subdomain
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "n8n.example.com.",
      Type: "A",
    });
  });

  test("Evolution API Stack creates expected resources", () => {
    const evolutionStack = new EvolutionApiStack(app, "TestEvolutionStack", {
      environment: "dev",
      domain: "example.com",
      desiredCount: 1,
      enableLogging: true,
      sharedInfrastructure: sharedInfraStack,
    });

    const template = Template.fromStack(evolutionStack);

    // Test that ECS cluster is created
    template.hasResourceProperties("AWS::ECS::Cluster", {});

    // Test that ECS service is created
    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
    });

    // Test that target group is created
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      Port: 8080,
      Protocol: "HTTP",
    });

    // Test that Route53 record is created for evolution subdomain
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "evolution.example.com.",
      Type: "A",
    });
  });

  test("Production environment has correct configuration", () => {
    const prodSharedInfraStack = new SharedInfrastructureStack(
      app,
      "ProdSharedInfraStack",
      {
        environment: "production",
        domain: "example.com",
        instanceClass: "db.t3.medium",
        enableBackup: true,
        enableMultiAz: true,
      }
    );

    const template = Template.fromStack(prodSharedInfraStack);

    // Test that RDS has backup enabled
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      BackupRetentionPeriod: 7,
      MultiAZ: true,
    });
  });
});
