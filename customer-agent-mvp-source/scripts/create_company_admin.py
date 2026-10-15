#!/usr/bin/env python3
import argparse
import boto3


def main():
    parser = argparse.ArgumentParser(description="Create the first company admin in Cognito")
    parser.add_argument("--region", required=True)
    parser.add_argument("--user-pool-id", required=True)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    client = boto3.client("cognito-idp", region_name=args.region)
    result = client.admin_create_user(UserPoolId=args.user_pool_id, Username=args.email.lower(),
        UserAttributes=[{"Name": "email", "Value": args.email.lower()}, {"Name": "email_verified", "Value": "true"},
                        {"Name": "name", "Value": args.name}, {"Name": "custom:tenant_id", "Value": args.tenant_id},
                        {"Name": "custom:role", "Value": "COMPANY_ADMIN"}], DesiredDeliveryMediums=["EMAIL"])
    print(f"Created company admin: {result['User']['Username']} for tenant {args.tenant_id}")


if __name__ == "__main__":
    main()

