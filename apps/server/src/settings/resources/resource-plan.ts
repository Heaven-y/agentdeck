import { builder, type ResourceContext, type ResourcePlan } from '../../agents/common/configuration/resources';
import { cliConfigurations } from '../../agents/registry';
export function resourcePlan(context: ResourceContext): ResourcePlan {
  const output = builder(context);
  cliConfigurations[context.agent].resources(context, output);
  return output.plan;
}
