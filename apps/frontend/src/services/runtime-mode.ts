/** Local UI preview deliberately stays offline until a developer configures an environment. */
export const isLocalPreview = import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE !== "cognito";
