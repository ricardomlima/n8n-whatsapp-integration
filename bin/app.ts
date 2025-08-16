#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { N8nWhatsappStack } from "../lib/n8n-whatsapp-stack";

const app = new cdk.App();

// Get environment from context or default to dev
const environment = app.node.tryGetContext("environment") || "dev";
const stackName = `n8n-whatsapp-${environment}`;

// Environment-specific configuration
const environments = {
  dev: {
    accountId: process.env.AWS_ACCOUNT_ID || "",
    region: process.env.AWS_REGION || "us-east-1",
    domain: undefined,
    certificateArn: undefined,
    instanceClass: "db.t3.micro",
    instanceType: "fargate",
    desiredCount: 1,
    enableLogging: true,
    enableBackup: false,
  },
  release: {
    accountId: process.env.AWS_ACCOUNT_ID || "",
    region: process.env.AWS_REGION || "us-east-1",
    domain: process.env.DOMAIN_NAME,
    certificateArn: process.env.CERTIFICATE_ARN,
    instanceClass: "db.t3.small",
    instanceType: "fargate",
    desiredCount: 2,
    enableLogging: true,
    enableBackup: true,
  },
  production: {
    accountId: process.env.AWS_ACCOUNT_ID || "",
    region: process.env.AWS_REGION || "us-east-1",
    domain: process.env.DOMAIN_NAME,
    certificateArn: process.env.CERTIFICATE_ARN,
    instanceClass: "db.t3.medium",
    instanceType: "fargate",
    desiredCount: 3,
    enableLogging: true,
    enableBackup: true,
    enableMultiAz: true,
  },
};

const config = environments[environment as keyof typeof environments];

if (!config) {
  throw new Error(`Unknown environment: ${environment}`);
}

new N8nWhatsappStack(app, stackName, {
  env: {
    account: config.accountId,
    region: config.region,
  },
  environment,
  ...config,
});

// Add tags to all resources
cdk.Tags.of(app).add("Project", "n8n-whatsapp-integration");
cdk.Tags.of(app).add("Environment", environment);
cdk.Tags.of(app).add("Owner", "Ricardo Lima");
