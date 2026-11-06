import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** Credentials are stored outside the MCP configuration and backup stores. */
export interface OAuthCredentials {
  serverUrl: string;
  redirectUri: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

export class OAuthLoginNeeded extends Error {
  constructor(public readonly resourceMetadataUrl?: string) {
    super("OAuth login required");
    this.name = "OAuthLoginNeeded";
  }
}

export class OAuthPreRegisteredClientRequired extends Error {
  constructor() {
    super("OAuth server requires a pre-registered client");
    this.name = "OAuthPreRegisteredClientRequired";
  }
}

export function httpUrl(value: string | URL): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid OAuth URL");
  return url;
}

export function hasManualAuthorization(headers?: Record<string, string>) {
  return Object.keys(headers ?? {}).some(
    (name) => name.toLowerCase() === "authorization",
  );
}

/**
 * SDK provider: background connections may refresh, but never register or open
 * a browser. Registration and redirects are enabled only by a user login.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  private authorizationUrl?: URL;
  private resourceMetadataUrl?: string;
  readonly saveClientInformation?: (
    client: OAuthClientInformationMixed,
  ) => Promise<void>;

  constructor(
    private credentials: OAuthCredentials,
    private readonly persist: (credentials: OAuthCredentials) => Promise<void>,
    private readonly interactive: boolean,
    private readonly loginState?: string,
  ) {
    if (interactive) {
      this.saveClientInformation = async (client) => {
        this.credentials.client = client;
        await this.persist(this.credentials);
      };
    }
  }

  get redirectUrl() {
    return this.credentials.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "NextChat",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    if (!this.interactive || !this.loginState)
      throw new OAuthLoginNeeded(this.resourceMetadataUrl);
    return this.loginState;
  }

  setResourceMetadataUrl(url?: URL) {
    this.resourceMetadataUrl = url?.href;
  }

  clientInformation() {
    return this.credentials.client;
  }
  tokens() {
    return this.credentials.tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    this.credentials.tokens = tokens;
    await this.persist(this.credentials);
  }

  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new OAuthLoginNeeded(this.resourceMetadataUrl);
    this.authorizationUrl = httpUrl(url);
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("OAuth session expired");
    return this.verifier;
  }

  takeAuthorizationUrl() {
    const url = this.authorizationUrl;
    this.authorizationUrl = undefined;
    return url;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    if (scope === "all" || scope === "client") delete this.credentials.client;
    if (scope === "all" || scope === "tokens") delete this.credentials.tokens;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    await this.persist(this.credentials);
  }
}
