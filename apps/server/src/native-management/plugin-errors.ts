const messages = {
  plugin_operation_missing: '未找到此范围的插件操作，请重新读取列表。',
  plugin_confirmation: '请确认此操作当前展示的准确原生命令。',
  plugin_capacity: '插件任务已达到保留上限，请稍后再试。',
  plugin_expired: '操作预览已过期，请重新准备。',
};
export class PluginError extends Error {
  readonly status = 409;
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
