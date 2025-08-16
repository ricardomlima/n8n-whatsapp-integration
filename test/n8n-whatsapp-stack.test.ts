import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { N8nWhatsappStack } from "../lib/n8n-whatsapp-stack";

describe("N8nWhatsappStack", () => {
  test("Stack creates expected resources", () => {
    const app = new cdk.App();
    const stack = new N8nWhatsappStack(app, "TestStack", {
      environment: "dev",
      instanceClass: "db.t3.micro",
      instanceType: "fargate",
      desiredCount: 1,
      enableLogging: true,
      enableBackup: false,
    });

    const template = Template.fromStack(stack);

    // Test that VPC is created
    template.hasResourceProperties("AWS::EC2::VPC", {
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });

    // Test that RDS instance is created
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      DBInstanceClass: "db.t3.micro",
    });

    // Test that ECS cluster is created
    template.hasResourceProperties("AWS::ECS::Cluster", {});

    // Test that ALB is created
    template.hasResourceProperties(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      {
        Type: "application",
        Scheme: "internet-facing",
      }
    );
  });

  test("Production environment has correct configuration", () => {
    const app = new cdk.App();
    const stack = new N8nWhatsappStack(app, "ProdStack", {
      environment: "production",
      instanceClass: "db.t3.medium",
      instanceType: "fargate",
      desiredCount: 3,
      enableLogging: true,
      enableBackup: true,
      enableMultiAz: true,
    });

    const template = Template.fromStack(stack);

    // Test that RDS has backup enabled
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      BackupRetentionPeriod: 7,
      MultiAZ: true,
    });
  });
});
