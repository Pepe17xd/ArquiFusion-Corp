import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { TenantConflictError } from "../tenancy/contracts";

export interface CognitoUserAdmin {
  invite(email: string): Promise<{ userSub: string }>;
  disable(userSub: string): Promise<void>;
}

/** Uses Cognito's managed invitation email; no password is accepted or logged. */
export class AwsCognitoUserAdmin implements CognitoUserAdmin {
  private readonly client = new CognitoIdentityProviderClient({});
  constructor(private readonly userPoolId: string) {
    if (!userPoolId) throw new Error("COGNITO_USER_POOL_ID is required for technician lifecycle operations");
  }

  async invite(email: string) {
    try {
      const result = await this.client.send(new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        UserAttributes: [{ Name: "email", Value: email }],
        DesiredDeliveryMediums: ["EMAIL"],
      }));
      const userSub = result.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
      if (!userSub) throw new Error("Cognito invitation did not return a user subject");
      return { userSub };
    } catch (error) {
      if (isUsernameExists(error)) throw new TenantConflictError("A Cognito account already exists for this email; it was not linked automatically");
      throw error;
    }
  }

  async disable(userSub: string) {
    const matches = await this.client.send(new ListUsersCommand({ UserPoolId: this.userPoolId, Filter: `sub = \"${escapeFilter(userSub)}\"`, Limit: 2 }));
    const matching = (matches.Users ?? []).filter((user) => user.Attributes?.some((attribute) => attribute.Name === "sub" && attribute.Value === userSub));
    if (!matching.length) return;
    if (matching.length > 1 || !matching[0].Username) throw new TenantConflictError("Cognito subject does not resolve to one account");
    const Username = matching[0].Username;
    await this.client.send(new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username }));
    await this.client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username }));
  }
}

function isUsernameExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "UsernameExistsException"); }
function escapeFilter(value: string) { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'); }
