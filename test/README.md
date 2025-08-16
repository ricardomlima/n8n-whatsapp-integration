# CDK Tests

This directory contains unit tests for the AWS CDK constructs.

## Test Structure

- `n8n-whatsapp-stack.test.ts`: Tests for the main infrastructure stack

## Running Tests

```bash
npm test
```

## Test Coverage

Tests verify:

- Resource creation and configuration
- Environment-specific settings
- Security configurations
- Network topology

## Adding Tests

When adding new constructs or modifying existing ones, ensure to add corresponding tests that verify:

1. Resources are created with correct properties
2. Security settings are applied correctly
3. Environment-specific configurations work as expected
