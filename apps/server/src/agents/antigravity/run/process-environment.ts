/** Windows 的原生后台更新器会另开控制台；只约束工作台子进程，不写用户配置或时间戳。 */
export function antigravityBackgroundEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return env;
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toUpperCase() !== 'AGY_CLI_DISABLE_AUTO_UPDATE'),
  );
  // agy 1.5.1 严格识别字符串 true，1 不生效。
  return { ...inherited, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
}

/** 官方登录沿用 AGY 网络环境，不把闲置的 Gemini Key 或 ADC 配置交给交互终端。 */
export function antigravityLoginEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const otherAuth =
    /^(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GEMINI_BASE_URL|AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_QUOTA_PROJECT|GOOGLE_CLOUD_LOCATION)$/i;
  return antigravityBackgroundEnvironment(
    Object.fromEntries(Object.entries(env).filter(([name]) => !otherAuth.test(name))),
  );
}

/** 只读官方能力不继承其他认证或命令覆盖，也保留 AGY 已解析的代理。 */
export function antigravityAccountReadEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overridden =
    /^(?:(?:AGY|ANTIGRAVITY|GEMINI|GOOGLE|GCLOUD|CLOUDSDK)_|XDG_(?:DATA|STATE)_HOME$|NODE_(?:OPTIONS|PATH)$)/i;
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !overridden.test(name))),
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  };
}
