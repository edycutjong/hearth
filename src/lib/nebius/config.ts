/**
 * Nebius configuration, read once from the environment.
 *
 * A judge opening the deploy with nothing configured must still get the sample, its A/B, search over it and
 * /proof (all served from committed files), so config resolution never throws: it returns a discriminated
 * result, and only the paths that start a Job or touch a visitor's space require `configured: true`.
 */

export interface NebiusConfig {
  /** Service account ID — the JWT `iss` and `sub`. */
  serviceAccountId: string;
  /** Authorized (public) key ID — the JWT `kid`. */
  authKeyId: string;
  /** PEM contents of the RSA private key that signs the JWT. */
  privateKeyPem: string;
  /** Project ID — `metadata.parentId` of every Job. */
  projectId: string;
  /** Required by the Jobs API when the project has more than one subnet. */
  subnetId: string;
  /** Region of the bucket and of the Jobs. */
  region: string;
  bucket: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  /** The image every Hearth Job runs. */
  workerImage: string;
  /** Set when the image already holds the Python dependencies (the baked worker image). */
  workerPrebuilt: boolean;
  /** Concurrent Hearth Jobs in the region. The tenant quota is 2 instances per region, shared. */
  maxConcurrentJobs: number;
}

export type ConfigResult =
  | { configured: true; config: NebiusConfig }
  | { configured: false; missing: string[] };

const REQUIRED = [
  "NEBIUS_SERVICE_ACCOUNT_ID",
  "NEBIUS_AUTH_KEY_ID",
  "NEBIUS_AUTH_PRIVATE_KEY",
  "NEBIUS_PROJECT_ID",
  "NEBIUS_SUBNET_ID",
  "NEBIUS_S3_ACCESS_KEY_ID",
  "NEBIUS_S3_SECRET_ACCESS_KEY",
] as const;

/** eu-west1 carries cpu-d3 and has CPU quota on this tenant (eu-north1 has a non-GPU vCPU quota of 0). */
export const DEFAULT_REGION = "eu-west1";
export const DEFAULT_BUCKET = "hearth-data";
/** Stock image + install at start; replaced by the baked worker image when HEARTH_WORKER_IMAGE is set. */
export const DEFAULT_WORKER_IMAGE = "python:3.11";

/**
 * One Hearth Job at a time per region. The tenant's `compute.instance.count` is 2 per region and is shared
 * with the builder's other entries; a third concurrent Job is rejected with QuotaExceeded, not queued.
 */
export const DEFAULT_MAX_CONCURRENT_JOBS = 1;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length > 0) return { configured: false, missing: [...missing] };
  const region = env.NEBIUS_REGION?.trim() || DEFAULT_REGION;
  const image = env.HEARTH_WORKER_IMAGE?.trim() || DEFAULT_WORKER_IMAGE;
  const max = Number(env.HEARTH_MAX_CONCURRENT_JOBS);
  return {
    configured: true,
    config: {
      serviceAccountId: req(env, "NEBIUS_SERVICE_ACCOUNT_ID"),
      authKeyId: req(env, "NEBIUS_AUTH_KEY_ID"),
      // A PEM pasted with `\n` escapes is unescaped; one stored with real newlines is untouched.
      privateKeyPem: req(env, "NEBIUS_AUTH_PRIVATE_KEY").replace(/\\n/g, "\n"),
      projectId: req(env, "NEBIUS_PROJECT_ID"),
      subnetId: req(env, "NEBIUS_SUBNET_ID"),
      region,
      bucket: env.HEARTH_BUCKET?.trim() || DEFAULT_BUCKET,
      s3Endpoint: env.NEBIUS_S3_ENDPOINT?.trim() || `https://storage.${region}.nebius.cloud`,
      s3AccessKeyId: req(env, "NEBIUS_S3_ACCESS_KEY_ID"),
      s3SecretAccessKey: req(env, "NEBIUS_S3_SECRET_ACCESS_KEY"),
      workerImage: image,
      workerPrebuilt: image !== DEFAULT_WORKER_IMAGE,
      maxConcurrentJobs: Number.isInteger(max) && max >= 1 && max <= 2 ? max : DEFAULT_MAX_CONCURRENT_JOBS,
    },
  };
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  /* v8 ignore next */
  if (!v) throw new Error(`missing required env var ${key}`);
  return v.trim();
}

export const NEBIUS_API_BASE = "https://api.nebius.cloud";
export const NEBIUS_TOKEN_EXCHANGE_URL = "https://auth.eu.nebius.com/oauth2/token/exchange";

/** Non-GPU AMD EPYC Genoa. */
export const WORKER_PLATFORM = "cpu-d3";
/** The product preset measured by the D0 harness. */
export const WORKER_PRESET = "4vcpu-16gb";

/** Token Factory: Nemotron 3 Super reads transcript text (never audio). */
export interface TokenFactoryConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const TOKEN_FACTORY_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
export const MEMORY_MODEL = "nvidia/nemotron-3-super-120b-a12b";

export function loadTokenFactoryConfig(env: NodeJS.ProcessEnv = process.env): TokenFactoryConfig | null {
  const apiKey = env.TOKENFACTORY_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.TOKENFACTORY_BASE_URL?.trim() || TOKEN_FACTORY_BASE_URL,
    model: env.HEARTH_MEMORY_MODEL?.trim() || MEMORY_MODEL,
  };
}
