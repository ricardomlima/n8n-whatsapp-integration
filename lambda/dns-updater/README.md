# DNS Updater Lambda Function

This Lambda function automatically updates Route 53 DNS records when ECS tasks change state to RUNNING.

## Purpose

When using ECS Fargate with public subnets and `assignPublicIp: true`, tasks get dynamic public IP addresses that change when the task restarts. This Lambda function automatically detects when a task starts running and updates the corresponding Route 53 DNS record with the new public IP address.

## How It Works

1. **EventBridge Integration**: The function is triggered by ECS Task State Change events
2. **IP Detection**: Extracts the public IP address from the running ECS task's ENI
3. **DNS Update**: Updates the Route 53 A record with the new IP address
4. **Logging**: Provides detailed logging for troubleshooting

## Environment Variables

- `HOSTED_ZONE_ID`: The Route 53 hosted zone ID where the DNS record exists
- `DOMAIN`: The base domain name (e.g., "avaeran.com")
- `RECORD_NAME`: The subdomain to update (defaults to "n8n")

## IAM Permissions Required

The Lambda function needs the following permissions:

- `route53:ChangeResourceRecordSets`
- `route53:GetChange`
- `ecs:DescribeTasks`
- `ec2:DescribeNetworkInterfaces`

## Event Pattern

The function expects ECS Task State Change events with the following pattern:

```json
{
  "source": ["aws.ecs"],
  "detail-type": ["ECS Task State Change"],
  "detail": {
    "clusterArn": ["arn:aws:ecs:region:account:cluster/cluster-name"],
    "group": ["service:service-name"],
    "lastStatus": ["RUNNING"]
  }
}
```

## Example Usage

When an ECS task with the service name matching the EventBridge rule starts running, the function will:

1. Extract the task's public IP (e.g., `54.123.45.67`)
2. Update the DNS record `n8n.avaeran.com` to point to that IP
3. Set a TTL of 60 seconds for quick updates
4. Log the successful update

## Error Handling

The function includes comprehensive error handling and logging:

- Validates event structure
- Handles missing ENI or public IP scenarios
- Provides detailed error messages
- Returns appropriate HTTP status codes

## Cost Optimization

- **Minimal compute time**: Typically runs in < 5 seconds
- **Pay-per-use**: Only charged when ECS tasks restart
- **Low frequency**: Most tasks run for hours/days without restarting
- **Expected cost**: < $0.20/month for typical usage

## Testing

You can test the function locally or invoke it with a sample ECS Task State Change event. See the AWS Lambda documentation for testing procedures.
