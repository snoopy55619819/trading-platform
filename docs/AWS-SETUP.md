# Setting up AWS for tradeplatform.dev

The one-time setup behind [DEPLOYMENT.md](DEPLOYMENT.md): every AWS resource, the DNS
record and the first release, in order. Each step is an AWS CLI command, so the setup can
be repeated exactly; the console works too.

**Where:** the "Trading Platform" project (its own AWS account), region `us-east-2`
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

The `deploy` workflow builds the five images and moves the `live` tag; within a minute the
server's agent pulls them. The images' packages on GitHub came out public, because the repo
is public and every image is labelled with it. If one is ever private, the server cannot
pull it: set it to public under the profile's **Packages** (Package settings, Change
visibility).

Then seed the broker's security master, once. Systems Manager runs it on the server; no
shell or SSH needed. `IMAGE_PREFIX` and `TAG` must name the released image: without them
compose looks for a local one and builds it from source on the server instead.

```bash
aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/trading-platform && IMAGE_PREFIX=ghcr.io/snoopy55619819/trading-platform TAG=v0.1.0 docker compose -f broker/deploy/compose.yml run --rm --no-deps backend node scripts/seed-securities.mjs"]'
```

For an interactive shell, `aws ssm start-session --target "$instance"` (it needs AWS's
Session Manager plugin installed locally).

## 7. Backups and alarms: about $1 a month

Nightly at 22:30 UTC, after the exchange's 21:00 roll,
[`hosting/backup.sh`](../hosting/backup.sh) dumps the three databases to S3 and archives
the exchange's finished day files there, gzipped, then deletes local day files that are
archived and over a week old. Hourly, [`hosting/disk-metric.sh`](../hosting/disk-metric.sh)
reports disk use. Both run from systemd timers that the deploy agent installs with each
release; they do nothing until the server's settings file exists.

A private bucket that deletes database dumps after 30 days and archived day files after a
year:

```bash
bucket=tradeplatform-dev-backups
aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration LocationConstraint=us-east-2
aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-tagging --bucket "$bucket" --tagging 'TagSet=[{Key=Project,Value=trading-platform}]'
aws s3api put-bucket-lifecycle-configuration --bucket "$bucket" --lifecycle-configuration '{"Rules":[
  {"ID":"database-dumps-30-days","Status":"Enabled","Filter":{"Prefix":"databases/"},"Expiration":{"Days":30}},
  {"ID":"exchange-days-1-year","Status":"Enabled","Filter":{"Prefix":"exchange-days/"},"Expiration":{"Days":365}}]}'
```

The server's role may write to that bucket and report its own metrics, nothing more:

```bash
aws iam put-role-policy --role-name trading-platform-server --policy-name backups-and-metrics \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject"],"Resource":"arn:aws:s3:::tradeplatform-dev-backups/*"},
    {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::tradeplatform-dev-backups"},
    {"Effect":"Allow","Action":"cloudwatch:PutMetricData","Resource":"*",
     "Condition":{"StringEquals":{"cloudwatch:namespace":"TradingPlatform"}}}]}'
```

The settings file on the server, written through Systems Manager:

```bash
aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript --parameters \
  'commands=["mkdir -p /etc/trading-platform","printf \"BACKUP_BUCKET=tradeplatform-dev-backups\\nAWS_REGION=us-east-2\\n\" > /etc/trading-platform/aws.env"]'
```

Alarms, emailed through a topic. The subscription sends one email to confirm first. The
disk alarm also fires if the hourly reports stop, which means the server is down; the
backup alarm fires if a night passes without a finished backup.

```bash
topic=$(aws sns create-topic --name trading-platform-alerts --tags Key=Project,Value=trading-platform \
  --query TopicArn --output text)
aws sns subscribe --topic-arn "$topic" --protocol email --notification-endpoint <your email>
aws cloudwatch put-metric-alarm --alarm-name trading-platform-disk \
  --alarm-description "Server disk over 80% full, or the server stopped reporting (down?)" \
  --namespace TradingPlatform --metric-name DiskUsedPercent --dimensions Name=Server,Value=trading-platform \
  --statistic Maximum --period 3600 --evaluation-periods 2 --threshold 80 \
  --comparison-operator GreaterThanThreshold --treat-missing-data breaching --alarm-actions "$topic"
aws cloudwatch put-metric-alarm --alarm-name trading-platform-backup \
  --alarm-description "No finished backup in the last day" \
  --namespace TradingPlatform --metric-name BackupCompleted --dimensions Name=Server,Value=trading-platform \
  --statistic Sum --period 86400 --evaluation-periods 1 --threshold 1 \
  --comparison-operator LessThanThreshold --treat-missing-data breaching --alarm-actions "$topic"
```

To run a backup now rather than wait for the night:
`sudo systemctl start backup.service`, then `journalctl -u backup` on the server.

## Checking on it

- The site: https://tradeplatform.dev, and https://tradeplatform.dev/version.txt for the
  live version.
- The deploy agent: `journalctl -u deploy-agent` on the server; backups: `journalctl -u backup`.
- Alarms: CloudWatch, Alarms, in `us-east-2`.
- First boot: `/var/log/cloud-init-output.log` on the server.
