# Setting up AWS for tradeplatform.dev

The one-time setup behind [DEPLOYMENT.md](DEPLOYMENT.md): every AWS resource, the DNS
record and the first release, in order. Each step is an AWS CLI command, so the setup can
be repeated exactly; the console works too.

**Where:** the "Trading Platform" project (AWS account `077815499810`), region `us-east-2`
(Ohio). The project's organization only allows `us-east-2`: elsewhere even listing servers
is refused. Every resource is tagged `Project=trading-platform`.

## Before anything that costs money

- [x] MFA on the login.
- [x] A budget: `trading-platform-monthly`, $30 a month, counting usage before Free plan
      credits. Emails at 80% of actual spend and when the month is forecast to pass $30.
- [ ] Upgrade to the paid plan before the Free plan's 182 days end, or AWS closes the
      account. Usage beyond the $100 of credits is billed.

## 1. The server's role: free

Lets the server use Systems Manager, so it can be reached with a shell without SSH.

```bash
aws iam create-role --role-name trading-platform-server \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --tags Key=Project,Value=trading-platform
aws iam attach-role-policy --role-name trading-platform-server \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name trading-platform-server
aws iam add-role-to-instance-profile --instance-profile-name trading-platform-server \
  --role-name trading-platform-server
```

## 2. The firewall: free

Only HTTPS, and HTTP for certificate renewal and the redirect to HTTPS. No SSH port.

```bash
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
sg=$(aws ec2 create-security-group --group-name trading-platform-web \
  --description "tradeplatform.dev: HTTP and HTTPS only" --vpc-id "$vpc" \
  --tag-specifications 'ResourceType=security-group,Tags=[{Key=Project,Value=trading-platform}]' \
  --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions \
  'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]' \
  'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]'
```

## 3. The server: about $14.70 a month

A `t4g.small` (2 vCPU, 2 GB, ARM) on Amazon Linux 2023 with a 30 GB disk. Its first boot
runs [`hosting/server-setup.sh`](../hosting/server-setup.sh): Docker, swap, automatic
security updates, the shared `trading` network, a clone of this repo, each company's `.env`
with passwords generated on the server, and the deploy agent. The script is read from the
repo, so it must be on `main` first.

```bash
ami=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query Parameter.Value --output text)
aws ec2 run-instances --image-id "$ami" --instance-type t4g.small \
  --iam-instance-profile Name=trading-platform-server --security-group-ids "$sg" \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3,Encrypted=true}' \
  --metadata-options HttpTokens=required \
  --user-data file://hosting/server-setup.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=trading-platform},{Key=Project,Value=trading-platform}]' \
                       'ResourceType=volume,Tags=[{Key=Project,Value=trading-platform}]'
```

## 4. A fixed address: about $3.65 a month

```bash
instance=$(aws ec2 describe-instances --filters Name=tag:Name,Values=trading-platform \
  Name=instance-state-name,Values=pending,running --query 'Reservations[0].Instances[0].InstanceId' --output text)
allocation=$(aws ec2 allocate-address --domain vpc \
  --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Project,Value=trading-platform}]' \
  --query AllocationId --output text)
aws ec2 associate-address --instance-id "$instance" --allocation-id "$allocation"
aws ec2 describe-addresses --allocation-ids "$allocation" --query 'Addresses[0].PublicIp' --output text
```

## 5. DNS, in Cloudflare

In the `tradeplatform.dev` zone, add an `A` record: name `@`, the Elastic IP from step 4,
proxy status **DNS only** (grey cloud). Caddy then gets its own Let's Encrypt certificate.

## 6. The first release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The `deploy` workflow builds the five images and moves the `live` tag. The first time,
GitHub creates the images' packages as **private**, and the server cannot pull them: on
GitHub, under the profile's **Packages**, set each `trading-platform/*` package to public
(Package settings, Change visibility). The server's agent retries every minute.

Then seed the broker's security master, once. Systems Manager runs it on the server; no
shell or SSH needed:

```bash
aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --parameters 'commands=["docker compose -f /opt/trading-platform/broker/deploy/compose.yml run --rm --no-deps backend node scripts/seed-securities.mjs"]'
```

For an interactive shell, `aws ssm start-session --target "$instance"` (it needs AWS's
Session Manager plugin installed locally).

## Checking on it

- The site: https://tradeplatform.dev, and https://tradeplatform.dev/version.txt for the
  live version.
- The deploy agent: `journalctl -u deploy-agent` on the server.
- First boot: `/var/log/cloud-init-output.log` on the server.
