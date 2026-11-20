import {
  managementObject as object,
  managementText as text,
  type ManagementRecord,
} from '../management/management-rpc';

function sourceMatches(source: ManagementRecord, trajectory: ManagementRecord, index: number) {
  return (
    source.stepIndex === index &&
    source.cascadeId === trajectory.cascadeId &&
    (!trajectory.trajectoryId || source.trajectoryId === trajectory.trajectoryId)
  );
}

function generatorAt(trajectory: ManagementRecord, index: number) {
  const entries: unknown[] = Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [];
  const offset = typeof trajectory.generatorMetadataOffset === 'number' ? trajectory.generatorMetadataOffset : 0;
  return object(entries[index - offset]);
}

/** 用原生执行与步骤身份核对生成记录；protobuf 的零索引可能省略。 */
export function matchedGenerationModel(
  trajectory: ManagementRecord,
  step: ManagementRecord,
  index: number,
): ManagementRecord | undefined {
  const metadata = object(step.metadata);
  const source = object(metadata.sourceTrajectoryStepInfo);
  const generatorIndex = source.metadataIndex === undefined ? 0 : source.metadataIndex;
  if (!Number.isSafeInteger(generatorIndex) || Number(generatorIndex) < 0 || !sourceMatches(source, trajectory, index))
    return;
  const generator = generatorAt(trajectory, Number(generatorIndex));
  if (!text(metadata.executionId) || generator.executionId !== metadata.executionId) return;
  if (!Array.isArray(generator.stepIndices) || generator.stepIndices.length !== 1 || generator.stepIndices[0] !== index)
    return;
  return object(generator.chatModel);
}

export function historyResponseModel(trajectory: ManagementRecord, step: ManagementRecord, index: number) {
  if (typeof trajectory.trajectoryId !== 'string' || !trajectory.trajectoryId) return;
  const model = matchedGenerationModel(trajectory, step, index)?.responseModel;
  return typeof model === 'string' && /^[\w][\w./: -]{0,159}$/u.test(model) ? model : undefined;
}
