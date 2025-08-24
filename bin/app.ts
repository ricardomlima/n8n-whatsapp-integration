#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { N8nStack } from "../lib/n8n-stack";
import { EvolutionApiStack } from "../lib/evolution-api-stack";

const app = new cdk.App();

// Get environment from context or default to dev
const environment = app.node.tryGetContext("environment") || "development";

// Environment-specific configuration
const environments = {
  development: {
    accountId: process.env.AWS_ACCOUNT_ID || "066284029583", // placeholder account for synthesis
    region: process.env.AWS_REGION || "us-east-1",
    domain: "avaeran.com",
    certificateArn:
      "arn:aws:acm:us-east-1:066284029583:certificate/d534e510-722f-4920-8c29-cd57ea3f6c6d",
    instanceClass: "db.t3.micro",
    instanceType: "fargate",
    desiredCount: 1,
    enableLogging: true,
    enableBackup: false,
    enableMultiAz: false,
  },
  release: {
    accountId: process.env.AWS_ACCOUNT_ID || "066284029583", // placeholder account for synthesis
    region: process.env.AWS_REGION || "us-east-1",
    domain: "avaeran.com",
    certificateArn: process.env.CERTIFICATE_ARN,
    instanceClass: "db.t3.small",
    instanceType: "fargate",
    desiredCount: 2,
    enableLogging: true,
    enableBackup: true,
    enableMultiAz: false,
  },
  production: {
    accountId: process.env.AWS_ACCOUNT_ID || "066284029583", // placeholder account for synthesis
    region: process.env.AWS_REGION || "us-east-1",
    domain: process.env.DOMAIN_NAME || "us-east-1",
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

const env = {
  account: config.accountId,
  region: config.region,
};

// Create n8n stack (completely independent)
const n8nStack = new N8nStack(app, `n8n-${environment}`, {
  env,
  environment,
  domain: config.domain,
  certificateArn: config.certificateArn,
  desiredCount: config.desiredCount,
  enableLogging: config.enableLogging,
  instanceClass: config.instanceClass,
  enableBackup: config.enableBackup,
  enableMultiAz: config.enableMultiAz,
});

// Create Evolution API stack (completely independent)
const evolutionStack = new EvolutionApiStack(
  app,
  `evolution-api-${environment}`,
  {
    env,
    environment,
    domain: config.domain,
    certificateArn: config.certificateArn,
    desiredCount: config.desiredCount,
    enableLogging: config.enableLogging,
    instanceClass: config.instanceClass,
    enableBackup: config.enableBackup,
    enableMultiAz: config.enableMultiAz,
  }
);

// No dependencies between stacks - they are completely isolated

// Add tags to all resources
cdk.Tags.of(app).add("Project", "n8n-whatsapp-integration");
cdk.Tags.of(app).add("Environment", environment);
cdk.Tags.of(app).add("Owner", "Ricardo Monteiro e Lima");
