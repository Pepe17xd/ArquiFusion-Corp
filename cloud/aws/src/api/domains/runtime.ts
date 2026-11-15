import { loadConfig, type RuntimeDomain } from "../../core/config";
import { createAuraRepository, createAuraWorkflow, createMachineRepository, createOperationalRepository, createOriginalFileStore, createTaskDispatcher, createTaskStore, createTenantDirectory, createTokenVerifier } from "../../storage";
import { StepFunctionsAnomalyDispatcher } from "../../operations/step-functions-dispatcher";
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
    operations: () => createOperationalRepository(config),
    aura: () => createAuraRepository(config),
    auraWorkflow: () => createAuraWorkflow(config),
    operationsDispatcher: () => config.operationsStateMachineArn ? new StepFunctionsAnomalyDispatcher(config.operationsStateMachineArn) : undefined,
    dispatcher: () => createTaskDispatcher(config),
  };
}
