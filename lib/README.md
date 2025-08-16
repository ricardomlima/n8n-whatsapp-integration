# CDK Constructs

This directory contains the AWS CDK construct definitions for the n8n + Evolution API deployment.

## Stack Overview

### N8nWhatsappStack

The main stack that provisions:

- **VPC**: Multi-AZ virtual private cloud with public, private, and isolated subnets
- **RDS PostgreSQL**: Database for both n8n and Evolution API
- **ElastiCache Redis**: Caching and queue management for n8n
- **ECS Fargate**: Container orchestration for n8n and Evolution API
- **Application Load Balancer**: Traffic distribution and SSL termination
- **Route 53**: DNS management (when domain is configured)
- **Security Groups**: Network access control
- **Secrets Manager**: Secure credential storage

## Environment Configurations

- **Development**: Single AZ, minimal resources, HTTP only
- **Release**: Multi AZ, production-like setup, HTTPS
- **Production**: Full HA deployment, encrypted storage, backups

## Usage

The stack is instantiated from `bin/app.ts` with environment-specific configurations.
