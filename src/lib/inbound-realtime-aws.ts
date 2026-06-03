/**
 * AWS wiring for real-time inbound. Isolated from inbound-realtime.ts so the
 * pure parser/poller stay SDK-free and testable.
 *
 * setupRealtimeInbound: creates an SNS topic + SQS queue, subscribes the queue
 * to the topic (raw delivery), grants SNS permission to the queue, and attaches
 * the topic to the domain's SES receipt-rule S3 action (TopicArn) so SES
 * notifies on every received message.
 *
 * makeSqsAdapter: a real SqsLike (long-poll receive + delete) for the watcher.
 */
import type { SqsLike, SqsMessage } from "./inbound-realtime.js";

export interface RealtimeCreds {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface SetupRealtimeOptions extends RealtimeCreds {
  domain: string;
  ruleSetName: string;
  ruleName: string;
}

export interface SetupRealtimeResult {
  topic_arn: string;
  queue_url: string;
  queue_arn: string;
  rule_updated: boolean;
}

function creds(c: RealtimeCreds) {
  return c.accessKeyId && c.secretAccessKey
    ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
    : undefined;
}

function regionOf(c: RealtimeCreds): string {
  return c.region || process.env["AWS_REGION"] || "us-east-1";
}

const sanitize = (domain: string) => `emails-inbound-${domain.replace(/[^a-zA-Z0-9]/g, "-")}`;

export async function setupRealtimeInbound(opts: SetupRealtimeOptions): Promise<SetupRealtimeResult> {
  const region = regionOf(opts);
  const c = creds(opts);
  const name = sanitize(opts.domain);

  const { SNSClient, CreateTopicCommand, SubscribeCommand } = await import("@aws-sdk/client-sns");
  const { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } = await import("@aws-sdk/client-sqs");
  const { SESClient, DescribeReceiptRuleCommand, UpdateReceiptRuleCommand } = await import("@aws-sdk/client-ses");

  const sns = new SNSClient({ region, credentials: c });
  const sqs = new SQSClient({ region, credentials: c });
  const ses = new SESClient({ region, credentials: c });

  // 1. SNS topic
  const topic = await sns.send(new CreateTopicCommand({ Name: name }));
  const topicArn = topic.TopicArn!;

  // 2. SQS queue + its ARN
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  const queueUrl = queue.QueueUrl!;
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }));
  const queueArn = attrs.Attributes?.["QueueArn"]!;

  // 3. Allow the topic to send to the queue
  const policy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "sns.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: queueArn,
      Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
    }],
  };
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify(policy) } }));

  // 4. Subscribe the queue to the topic (raw delivery → Body is the SES message)
  await sns.send(new SubscribeCommand({
    TopicArn: topicArn,
    Protocol: "sqs",
    Endpoint: queueArn,
    Attributes: { RawMessageDelivery: "true" },
    ReturnSubscriptionArn: true,
  }));

  // 5. Attach the topic to the SES rule's S3 action so SES notifies on receipt.
  let ruleUpdated = false;
  try {
    const desc = await ses.send(new DescribeReceiptRuleCommand({ RuleSetName: opts.ruleSetName, RuleName: opts.ruleName }));
    const rule = desc.Rule;
    if (rule?.Actions) {
      // Always (re)point the S3 action at this topic — re-running setup after
      // the topic was recreated must rewire, not silently keep a stale ARN.
      for (const action of rule.Actions) {
        if (action.S3Action) action.S3Action.TopicArn = topicArn;
      }
      await ses.send(new UpdateReceiptRuleCommand({ RuleSetName: opts.ruleSetName, Rule: rule }));
      ruleUpdated = true;
    }
  } catch {
    // Rule wiring is best-effort; the queue/topic still exist for manual wiring.
  }

  return { topic_arn: topicArn, queue_url: queueUrl, queue_arn: queueArn, rule_updated: ruleUpdated };
}

export interface SqsAdapterOptions extends RealtimeCreds {
  queueUrl: string;
  waitTimeSeconds?: number;
  maxMessages?: number;
}

/** A real SqsLike backed by @aws-sdk/client-sqs (long-poll receive + delete). */
export function makeSqsAdapter(opts: SqsAdapterOptions): SqsLike {
  const region = regionOf(opts);
  const c = creds(opts);
  // One client for the lifetime of the watcher — the loop reuses it instead of
  // doing a TLS handshake on every poll.
  let clientPromise: Promise<{ client: unknown; ReceiveMessageCommand: unknown; DeleteMessageCommand: unknown }> | null = null;
  async function getClient() {
    if (!clientPromise) {
      clientPromise = import("@aws-sdk/client-sqs").then(({ SQSClient, ReceiveMessageCommand, DeleteMessageCommand }) => ({
        client: new SQSClient({ region, credentials: c }),
        ReceiveMessageCommand, DeleteMessageCommand,
      }));
    }
    return clientPromise;
  }
  return {
    async receive(): Promise<SqsMessage[]> {
      const { client, ReceiveMessageCommand } = await getClient();
      const Cmd = ReceiveMessageCommand as new (i: unknown) => unknown;
      const res = await (client as { send: (c: unknown) => Promise<{ Messages?: Array<{ ReceiptHandle?: string; Body?: string }> }> }).send(new Cmd({
        QueueUrl: opts.queueUrl,
        MaxNumberOfMessages: opts.maxMessages ?? 10,
        WaitTimeSeconds: opts.waitTimeSeconds ?? 20,
      }));
      return (res.Messages ?? []).map((m) => ({ ReceiptHandle: m.ReceiptHandle ?? "", Body: m.Body ?? "" }));
    },
    async deleteMessage(receiptHandle: string): Promise<void> {
      const { client, DeleteMessageCommand } = await getClient();
      const Cmd = DeleteMessageCommand as new (i: unknown) => unknown;
      await (client as { send: (c: unknown) => Promise<unknown> }).send(new Cmd({ QueueUrl: opts.queueUrl, ReceiptHandle: receiptHandle }));
    },
  };
}
