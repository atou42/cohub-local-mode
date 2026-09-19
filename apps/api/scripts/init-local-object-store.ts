import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const endpoint = process.env.TURN_OBJECT_S3_ENDPOINT?.trim();
const region = process.env.TURN_OBJECT_S3_REGION?.trim();
const accessKeyId = process.env.TURN_OBJECT_S3_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY?.trim();
const webOrigin = process.env.WEB_ORIGIN?.trim();
if (!endpoint || !region || !accessKeyId || !secretAccessKey || !webOrigin) {
  throw new Error(
    "Object store initialization requires endpoint, region, credentials, and WEB_ORIGIN",
  );
}

const buckets = Array.from(
  new Set(
    [
      process.env.TURN_OBJECT_S3_BUCKET,
      process.env.PUBLIC_ASSET_OSS_BUCKET,
      process.env.CHECKPOINT_ASSET_OSS_BUCKET,
      process.env.SPACE_UPLOAD_S3_BUCKET,
      process.env.CHAT_ATTACHMENT_S3_BUCKET,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  ),
);
if (buckets.length === 0)
  throw new Error("At least one local object bucket is required");

const client = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: { accessKeyId, secretAccessKey },
});

for (const bucket of buckets) {
  const exists = await client
    .send(new HeadBucketCommand({ Bucket: bucket }))
    .then(
      () => true,
      (error) => {
        const status = (error as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        if (status === 404) return false;
        throw error;
      },
    );
  if (!exists) await client.send(new CreateBucketCommand({ Bucket: bucket }));
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: ["s3:GetObject"],
            Resource: [`arn:aws:s3:::${bucket}/*`],
          },
        ],
      }),
    }),
  );
}

console.log(`Initialized local object buckets: ${buckets.join(", ")}`);
