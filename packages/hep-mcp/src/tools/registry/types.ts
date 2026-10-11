import { z } from 'zod';
import type {
  CreateMessageRequest,
  CreateMessageRequestParamsBase,
  CreateMessageResult,
  CreateMessageResultWithTools,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRiskLevel } from '@nullius/shared';

export type ToolExposureMode = 'standard' | 'full';
export type ToolExposure = 'standard' | 'full';
export type ToolTier = 'core' | 'consolidated' | 'advanced' | 'writing';
export type ToolMaturity = 'stable' | 'experimental' | 'deprecated';
export type ToolSamplingCreateMessage = {
  (params: CreateMessageRequestParamsBase): Promise<CreateMessageResult>;
  (params: CreateMessageRequest['params']): Promise<CreateMessageResult | CreateMessageResultWithTools>;
};

export interface ToolHandlerContext {
  reportProgress?: (progress: number, total?: number, message?: string) => void;
  rawArgs?: Record<string, unknown>;
  createMessage?: ToolSamplingCreateMessage;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

export interface ToolSpec<TSchema extends z.ZodType<any, any> = z.ZodType<any, any>> {
  name: string;
  description: string;
  tier: ToolTier;
  intent?: string;
  maturity?: ToolMaturity;
  exposure: ToolExposure;
  riskLevel: ToolRiskLevel;
  zodSchema: TSchema;
  handler: (params: z.output<TSchema>, ctx: ToolHandlerContext) => Promise<unknown>;
  /**
   * The handler admits its project roots and resolves its own HEP data root
   * (admin tools with a `hep_data_root` override), so the dispatcher does not
   * wrap it in the per-call data root and does not add the `project_root`
   * routing field. Such a handler also checks its own path arguments against
   * the data root it resolves: the dispatcher's generic `options.output_dir`
   * check only knows the ambient root.
   */
  resolvesOwnDataRoot?: boolean;
}

export function isToolExposed(spec: ToolSpec, mode: ToolExposureMode): boolean {
  return mode === 'full' ? true : spec.exposure === 'standard';
}

export function isAdvancedToolSpec(spec: ToolSpec): boolean {
  return spec.tier === 'advanced';
}
