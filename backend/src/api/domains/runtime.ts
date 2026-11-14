import { loadConfig, type RuntimeDomain } from "../../core/config";
import { createMachineRepository, createOriginalFileStore, createTaskDispatcher, createTaskStore, createTenantDirectory, createTokenVerifier } from "../../storage";
import { createRequestAuthorizer } from "../request-authorizer";

export function createDomainRuntime(domain: RuntimeDomain) {
  const config = loadConfig(process.env, domain);
  const tenants = createTenantDirectory(config);
  const auth = createRequestAuthorizer({ authMode: config.authMode, tenants, tokenVerifier: createTokenVerifier(config) });
  return {
    config, auth, tenants,
    machines: () => createMachineRepository(config),
    originals: () => createOriginalFileStore(config),
    tasks: () => createTaskStore(config),
    dispatcher: () => createTaskDispatcher(config),
  };
}
