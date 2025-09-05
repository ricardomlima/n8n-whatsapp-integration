import boto3
import json
import logging
import os

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    """
    AWS Lambda function to automatically update Route 53 DNS records
    when ECS tasks change state to RUNNING.

    This function:
    1. Receives ECS Task State Change events from EventBridge
    2. Extracts the public IP address from the running task
    3. Updates the Route 53 A record with the new IP address

    Environment Variables:
    - HOSTED_ZONE_ID: The Route 53 hosted zone ID
    - DOMAIN: The base domain name (e.g., avaeran.com)
    - RECORD_NAME: The subdomain to update (defaults to 'n8n')
    """

    try:
        logger.info(f"Received event: {json.dumps(event, indent=2)}")

        # Parse the ECS task state change event
        detail = event.get("detail", {})

        # Only process RUNNING tasks
        if detail.get("lastStatus") != "RUNNING":
            logger.info(f"Task not in RUNNING state: {detail.get('lastStatus')}")
            return {
                "statusCode": 200,
                "body": json.dumps(
                    {"message": "Task not running, skipping DNS update"}
                ),
            }

        # Get task ARN and cluster ARN
        task_arn = detail.get("taskArn")
        cluster_arn = detail.get("clusterArn")

        if not task_arn or not cluster_arn:
            logger.error("Missing task ARN or cluster ARN in event")
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Missing required ARNs"}),
            }

        logger.info(f"Processing task: {task_arn}")

        # Get public IP from ECS task
        public_ip = get_task_public_ip(task_arn, cluster_arn)

        if not public_ip:
            logger.error("Could not retrieve public IP from task")
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "No public IP found"}),
            }

        # Update DNS record
        change_id = update_dns_record(public_ip)

        success_response = {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "message": "DNS record updated successfully",
                    "domain": get_full_domain_name(),
                    "ip": public_ip,
                    "changeId": change_id,
                }
            ),
        }

        logger.info(f"DNS update completed successfully: {success_response}")
        return success_response

    except Exception as e:
        error_message = f"Error updating DNS record: {str(e)}"
        logger.error(error_message)
        logger.error(f"Event: {json.dumps(event)}")

        return {
            "statusCode": 500,
            "body": json.dumps({"error": error_message, "event": event}),
        }


def get_task_public_ip(task_arn, cluster_arn):
    """
    Retrieve the public IP address of an ECS task.

    Args:
        task_arn: The ARN of the ECS task
        cluster_arn: The ARN of the ECS cluster

    Returns:
        str: The public IP address, or None if not found
    """
    try:
        # Initialize AWS clients
        ecs_client = boto3.client("ecs")
        ec2_client = boto3.client("ec2")

        # Get task details to find ENI
        response = ecs_client.describe_tasks(cluster=cluster_arn, tasks=[task_arn])

        if not response["tasks"]:
            logger.error("No tasks found in describe_tasks response")
            return None

        task = response["tasks"][0]
        logger.info(f"Task definition: {task.get('taskDefinitionArn', 'N/A')}")

        # Find ENI ID from task attachments
        eni_id = extract_eni_id(task)

        if not eni_id:
            logger.error("No ENI ID found in task attachments")
            return None

        logger.info(f"Found ENI ID: {eni_id}")

        # Get public IP from ENI
        public_ip = get_eni_public_ip(ec2_client, eni_id)

        if public_ip:
            logger.info(f"Found public IP: {public_ip}")

        return public_ip

    except Exception as e:
        logger.error(f"Error getting task public IP: {str(e)}")
        return None


def extract_eni_id(task):
    """
    Extract the ENI ID from ECS task attachments.

    Args:
        task: The ECS task description

    Returns:
        str: The ENI ID, or None if not found
    """
    attachments = task.get("attachments", [])

    for attachment in attachments:
        if attachment.get("type") == "ElasticNetworkInterface":
            for detail_item in attachment.get("details", []):
                if detail_item.get("name") == "networkInterfaceId":
                    return detail_item.get("value")

    return None


def get_eni_public_ip(ec2_client, eni_id):
    """
    Get the public IP address associated with an ENI.

    Args:
        ec2_client: Boto3 EC2 client
        eni_id: The ENI ID

    Returns:
        str: The public IP address, or None if not found
    """
    try:
        eni_response = ec2_client.describe_network_interfaces(
            NetworkInterfaceIds=[eni_id]
        )

        if not eni_response["NetworkInterfaces"]:
            logger.error(f"ENI {eni_id} not found")
            return None

        eni = eni_response["NetworkInterfaces"][0]
        association = eni.get("Association", {})
        public_ip = association.get("PublicIp")

        if not public_ip:
            logger.error(f"No public IP found for ENI {eni_id}")
            return None

        return public_ip

    except Exception as e:
        logger.error(f"Error getting ENI public IP: {str(e)}")
        return None


def update_dns_record(public_ip):
    """
    Update the Route 53 DNS record with the new public IP.

    Args:
        public_ip: The new public IP address

    Returns:
        str: The Route 53 change ID
    """
    try:
        route53_client = boto3.client("route53")

        # Get environment variables
        hosted_zone_id = os.environ.get("HOSTED_ZONE_ID")
        domain = os.environ.get("DOMAIN")
        record_name = os.environ.get("RECORD_NAME", "n8n")

        if not hosted_zone_id or not domain:
            raise ValueError(
                "Missing required environment variables: HOSTED_ZONE_ID, DOMAIN"
            )

        full_domain = f"{record_name}.{domain}"

        # Create change batch
        change_batch = {
            "Comment": f'Auto-update {full_domain} DNS to {public_ip} at {context.aws_request_id if "context" in globals() else "unknown"}',
            "Changes": [
                {
                    "Action": "UPSERT",
                    "ResourceRecordSet": {
                        "Name": full_domain,
                        "Type": "A",
                        "TTL": 60,
                        "ResourceRecords": [{"Value": public_ip}],
                    },
                }
            ],
        }

        # Update Route 53 record
        route53_response = route53_client.change_resource_record_sets(
            HostedZoneId=hosted_zone_id, ChangeBatch=change_batch
        )

        change_id = route53_response["ChangeInfo"]["Id"]
        logger.info(f"DNS record updated successfully!")
        logger.info(f"Domain: {full_domain} -> IP: {public_ip}")
        logger.info(f"Change ID: {change_id}")

        return change_id

    except Exception as e:
        logger.error(f"Error updating Route 53 record: {str(e)}")
        raise


def get_full_domain_name():
    """
    Get the full domain name being managed.

    Returns:
        str: The full domain name (e.g., n8n.avaeran.com)
    """
    domain = os.environ.get("DOMAIN", "unknown.com")
    record_name = os.environ.get("RECORD_NAME", "n8n")
    return f"{record_name}.{domain}"
