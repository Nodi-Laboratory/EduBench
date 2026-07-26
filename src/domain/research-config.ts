import { createHash } from 'node:crypto';
import { z } from 'zod';

export const researchConfigKinds = [
  'document_parse',
  'embedding_rag',
  'question_generation',
  'benchmark_models',
] as const;

export type ResearchConfigKind = (typeof researchConfigKinds)[number];

const versionSchema = z.string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const titleSchema = z.string().trim().min(2).max(120);
const explanationSchema = z.string().trim().min(20).max(1_000);
const modelIdSchema = z.string().trim().min(1).max(200).regex(/^\S+$/);
const positiveTimeoutSchema = z.number().int().min(1_000).max(600_000);

const commonDefinitionFields = {
  schemaVersion:z.literal(1),
  version:versionSchema,
  title:titleSchema,
  description:explanationSchema,
  applyScope:explanationSchema,
  reprocessingImpact:explanationSchema,
};

const base64ElementSchema = z.enum(['table', 'figure', 'chart', 'equation']);
const requiredBase64Elements = ['table', 'figure', 'chart', 'equation'] as const;

const rasterizationSchema = z.discriminatedUnion('format', [
  z.object({
    format:z.literal('png'),
    lossless:z.literal(true),
    dpi:z.number().int().min(150).max(600),
  }).strict(),
  z.object({
    format:z.literal('jpeg'),
    lossless:z.literal(false),
    dpi:z.number().int().min(150).max(600),
    jpegQuality:z.number().int().min(60).max(100),
  }).strict(),
]);

export const documentParseResearchConfigSchema = z.object({
  ...commonDefinitionFields,
  kind:z.literal('document_parse'),
  settings:z.object({
    provider:z.literal('upstage'),
    model:modelIdSchema,
    mode:z.enum(['standard', 'enhanced', 'auto']),
    ocr:z.enum(['auto', 'force']),
    outputFormat:z.enum(['html', 'markdown', 'both']),
    base64Encoding:z.array(base64ElementSchema).length(4),
    rasterization:rasterizationSchema,
    pagesPerBatch:z.number().int().min(1).max(100),
    pageConcurrency:z.number().int().min(1).max(20),
    requestTimeoutMs:positiveTimeoutSchema,
  }).strict().superRefine((settings, context) => {
    const actual = new Set(settings.base64Encoding);
    if (
      actual.size !== requiredBase64Elements.length
      || requiredBase64Elements.some((element) => !actual.has(element))
    ) {
      context.addIssue({
        code:'custom',
        path:['base64Encoding'],
        message:'table, figure, chart, equation을 각각 한 번씩 포함해야 합니다.',
      });
    }
  }),
}).strict();

export const embeddingRagResearchConfigSchema = z.object({
  ...commonDefinitionFields,
  kind:z.literal('embedding_rag'),
  settings:z.object({
    provider:z.literal('gemini'),
    model:modelIdSchema,
    dimensions:z.number().int().min(128).max(3072),
    vectorSpaceId:z.string().trim().min(3).max(200).regex(/^[a-zA-Z0-9._:/-]+$/),
    documentTaskType:z.literal('RETRIEVAL_DOCUMENT'),
    queryTaskType:z.literal('RETRIEVAL_QUERY'),
    prefixStrategy:z.enum(['task_type', 'text_prefix']),
    documentPrefix:z.string().max(120),
    queryPrefix:z.string().max(120),
    similarityMetric:z.literal('cosine'),
    chunkTargetTokens:z.number().int().min(64).max(4_096),
    retrievalTopK:z.number().int().min(1).max(100),
    neighborWindow:z.number().int().min(0).max(5),
    batchSize:z.number().int().min(1).max(100),
    concurrency:z.number().int().min(1).max(20),
    requestTimeoutMs:positiveTimeoutSchema,
  }).strict().superRefine((settings, context) => {
    const usesTextPrefixes = settings.prefixStrategy === 'text_prefix';
    if (usesTextPrefixes && (!settings.documentPrefix.trim() || !settings.queryPrefix.trim())) {
      context.addIssue({
        code:'custom',
        path:['prefixStrategy'],
        message:'text_prefix 전략에는 문서와 질의 접두사가 모두 필요합니다.',
      });
    }
    if (!usesTextPrefixes && (settings.documentPrefix || settings.queryPrefix)) {
      context.addIssue({
        code:'custom',
        path:['prefixStrategy'],
        message:'task_type 전략에서는 텍스트 접두사를 비워야 합니다.',
      });
    }
  }),
}).strict();

export const questionGenerationResearchConfigSchema = z.object({
  ...commonDefinitionFields,
  kind:z.literal('question_generation'),
  settings:z.object({
    provider:z.literal('gemini'),
    model:modelIdSchema,
    directionMaxOutputTokens:z.number().int().min(512).max(16_384),
    questionMaxOutputTokens:z.number().int().min(4_096).max(65_536),
    thinkingLevel:z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']),
    structuredOutput:z.literal(true),
    responseMimeType:z.literal('application/json'),
    concurrency:z.number().int().min(1).max(20),
    requestTimeoutMs:positiveTimeoutSchema,
  }).strict(),
}).strict();

const benchmarkGenerationSettingsSchema = z.object({
  maxOutputTokens:z.number().int().min(1).max(131_072),
  temperature:z.number().finite().min(0).max(2).nullable(),
  topP:z.number().finite().min(0).max(1).nullable(),
  presencePenalty:z.number().finite().min(-2).max(2).nullable(),
  frequencyPenalty:z.number().finite().min(-2).max(2).nullable(),
  thinkingLevel:z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']).nullable(),
  enableThinking:z.boolean().nullable(),
  omitTemperature:z.boolean(),
  omitTopP:z.boolean(),
  stopSequences:z.array(z.string().min(1).max(200)).max(16),
  seed:z.number().int().min(0).max(2_147_483_647).nullable(),
}).strict();

const benchmarkModelRuntimeFields = {
  displayName:z.string().trim().min(1).max(80),
  enabled:z.boolean(),
  modelId:modelIdSchema,
  concurrency:z.number().int().min(1).max(50),
  requestIntervalMs:z.number().int().min(0).max(60_000),
  requestTimeoutMs:positiveTimeoutSchema,
  generation:benchmarkGenerationSettingsSchema,
};

const benchmarkModelSchema = z.discriminatedUnion('providerKey', [
  z.object({
    providerKey:z.literal('gemini'),
    protocol:z.literal('gemini'),
    ...benchmarkModelRuntimeFields,
  }).strict(),
  z.object({
    providerKey:z.literal('upstage'),
    protocol:z.literal('openai-compatible'),
    ...benchmarkModelRuntimeFields,
  }).strict(),
  z.object({
    providerKey:z.literal('exaone'),
    protocol:z.literal('openai-compatible'),
    ...benchmarkModelRuntimeFields,
  }).strict(),
]);

export const benchmarkModelsResearchConfigSchema = z.object({
  ...commonDefinitionFields,
  kind:z.literal('benchmark_models'),
  settings:z.object({
    models:z.array(benchmarkModelSchema).length(3),
  }).strict().superRefine((settings, context) => {
    const providers = new Set(settings.models.map((model) => model.providerKey));
    if (
      providers.size !== 3
      || !['gemini', 'upstage', 'exaone'].every((provider) => providers.has(
        provider as 'gemini' | 'upstage' | 'exaone',
      ))
    ) {
      context.addIssue({
        code:'custom',
        path:['models'],
        message:'Gemini, Upstage, EXAONE 설정을 각각 한 개씩 포함해야 합니다.',
      });
    }
  }),
}).strict();

export const researchConfigDefinitionSchema = z.discriminatedUnion('kind', [
  documentParseResearchConfigSchema,
  embeddingRagResearchConfigSchema,
  questionGenerationResearchConfigSchema,
  benchmarkModelsResearchConfigSchema,
]);

export type DocumentParseResearchConfig = z.infer<typeof documentParseResearchConfigSchema>;
export type EmbeddingRagResearchConfig = z.infer<typeof embeddingRagResearchConfigSchema>;
export type QuestionGenerationResearchConfig = z.infer<typeof questionGenerationResearchConfigSchema>;
export type BenchmarkModelsResearchConfig = z.infer<typeof benchmarkModelsResearchConfigSchema>;
export type ResearchConfigDefinition = z.infer<typeof researchConfigDefinitionSchema>;
export type BenchmarkResearchModel =
  BenchmarkModelsResearchConfig['settings']['models'][number];

export function benchmarkGenerationParameters(
  model: BenchmarkResearchModel,
): Record<string, unknown> {
  const generation = model.generation;
  return {
    maxOutputTokens:generation.maxOutputTokens,
    stopSequences:[...generation.stopSequences],
    omitTemperature:generation.omitTemperature,
    omitTopP:generation.omitTopP,
    ...(generation.temperature == null
      ? {}
      : { temperature:generation.temperature }),
    ...(generation.topP == null ? {} : { topP:generation.topP }),
    ...(generation.presencePenalty == null
      ? {}
      : { presencePenalty:generation.presencePenalty }),
    ...(generation.frequencyPenalty == null
      ? {}
      : { frequencyPenalty:generation.frequencyPenalty }),
    ...(generation.thinkingLevel == null
      ? {}
      : { thinkingLevel:generation.thinkingLevel }),
    ...(generation.enableThinking == null
      ? {}
      : { enableThinking:generation.enableThinking }),
    ...(generation.seed == null ? {} : { seed:generation.seed }),
  };
}

export const defaultResearchConfigDefinitions: ResearchConfigDefinition[] = [
  {
    schemaVersion:1,
    kind:'document_parse',
    version:'document-parse-upstage-v1',
    title:'Upstage Document Parse 연구 기본값',
    description:'교과서의 표·그림·차트·수식을 원본 화질로 보존하면서 페이지 단위 분석 결과를 수집하는 기본 파싱 설정입니다.',
    applyScope:'활성화 이후 새로 등록하는 교과서 파싱 작업과 Document Lab의 새 분석 요청에 적용됩니다.',
    reprocessingImpact:'파싱 결과와 청크 근거가 달라질 수 있으므로 변경 효과를 기존 교과서에 반영하려면 전체 문서를 다시 처리해야 합니다.',
    settings:{
      provider:'upstage',
      model:'document-parse',
      mode:'enhanced',
      ocr:'force',
      outputFormat:'html',
      base64Encoding:['table', 'figure', 'chart', 'equation'],
      rasterization:{ format:'png', lossless:true, dpi:300 },
      pagesPerBatch:10,
      pageConcurrency:4,
      requestTimeoutMs:120_000,
    },
  },
  {
    schemaVersion:1,
    kind:'embedding_rag',
    version:'embedding-rag-gemini-embedding-2-3072-text-prefix-v1',
    title:'Gemini Embedding 2 · 선수관계 RAG 기본값',
    description:'Gemini Embedding 2가 지원하는 텍스트 지시 접두사로 교과서 근거와 선수관계 검색 질의를 구분하는 3072차원 RAG 설정입니다.',
    applyScope:'활성화 이후 새로 벡터화하는 교과서 청크와 그 벡터 공간을 사용하는 새 질문 생성 검색에 적용됩니다.',
    reprocessingImpact:'기존 임베딩과 벡터 공간이 다르므로 현재 설정을 적용하려면 원본 교과서를 새 처리 계보로 다시 파싱하고 임베딩해야 합니다.',
    settings:{
      provider:'gemini',
      model:'gemini-embedding-2',
      dimensions:3072,
      vectorSpaceId:'gemini-embedding-2:3072:text-prefix-prerequisite-rag-v1',
      documentTaskType:'RETRIEVAL_DOCUMENT',
      queryTaskType:'RETRIEVAL_QUERY',
      prefixStrategy:'text_prefix',
      documentPrefix:'title: none | text: ',
      queryPrefix:'task: search result | query: ',
      similarityMetric:'cosine',
      chunkTargetTokens:512,
      retrievalTopK:12,
      neighborWindow:1,
      batchSize:50,
      concurrency:3,
      requestTimeoutMs:120_000,
    },
  },
  {
    schemaVersion:1,
    kind:'question_generation',
    version:'question-generation-gemini-3.6-flash-v1',
    title:'Gemini 3.6 Flash 문항 생성 기본값',
    description:'Gemini 3.6 Flash의 구조화 출력과 고수준 사고를 사용해 각 문항의 방향 생성·근거 검색·문항 생성을 독립적으로 수행합니다.',
    applyScope:'활성화 이후 새로 만드는 질문 생성 배치에만 적용되며 이미 생성 중이거나 완료된 배치의 설정은 바뀌지 않습니다.',
    reprocessingImpact:'기존 교과서 임베딩은 그대로 사용할 수 있지만 변경된 생성 결과를 비교하려면 새 질문 배치를 만들어야 합니다.',
    settings:{
      provider:'gemini',
      model:'gemini-3.6-flash',
      directionMaxOutputTokens:2_048,
      questionMaxOutputTokens:16_384,
      thinkingLevel:'HIGH',
      structuredOutput:true,
      responseMimeType:'application/json',
      concurrency:4,
      requestTimeoutMs:180_000,
    },
  },
  {
    schemaVersion:1,
    kind:'benchmark_models',
    version:'benchmark-models-core-v2',
    title:'Gemini 3.6·Solar Pro 3·K-EXAONE 비교 기본값',
    description:'동일한 데이터셋을 Gemini 3.6 Flash, Upstage Solar Pro 3, K-EXAONE 236B A23B의 고정 모델 식별자와 재현 가능한 생성 파라미터로 비교합니다.',
    applyScope:'활성화 이후 새로 생성하는 벤치마크 실행의 모델 선택과 요청 파라미터 기본값에만 적용됩니다.',
    reprocessingImpact:'교과서나 질문을 다시 처리할 필요는 없지만 기존 실행에는 소급 적용되지 않으므로 비교하려면 새 실행을 만들어야 합니다.',
    settings:{
      models:[
        {
          providerKey:'gemini',
          displayName:'Gemini 3.6 Flash',
          protocol:'gemini',
          enabled:true,
          modelId:'gemini-3.6-flash',
          concurrency:4,
          requestIntervalMs:0,
          requestTimeoutMs:180_000,
          generation:{
            maxOutputTokens:16_384,
            temperature:null,
            topP:null,
            presencePenalty:null,
            frequencyPenalty:null,
            thinkingLevel:'HIGH',
            enableThinking:null,
            omitTemperature:true,
            omitTopP:true,
            stopSequences:[],
            seed:null,
          },
        },
        {
          providerKey:'upstage',
          displayName:'Upstage Solar Pro 3',
          protocol:'openai-compatible',
          enabled:true,
          modelId:'solar-pro3',
          concurrency:3,
          requestIntervalMs:0,
          requestTimeoutMs:180_000,
          generation:{
            maxOutputTokens:16_384,
            temperature:0.7,
            topP:0.95,
            presencePenalty:0,
            frequencyPenalty:0,
            thinkingLevel:null,
            enableThinking:null,
            omitTemperature:false,
            omitTopP:false,
            stopSequences:[],
            seed:null,
          },
        },
        {
          providerKey:'exaone',
          displayName:'K-EXAONE 236B A23B',
          protocol:'openai-compatible',
          enabled:true,
          modelId:'LGAI-EXAONE/K-EXAONE-236B-A23B',
          concurrency:1,
          requestIntervalMs:30_000,
          requestTimeoutMs:300_000,
          generation:{
            maxOutputTokens:16_384,
            temperature:1,
            topP:0.95,
            presencePenalty:0,
            frequencyPenalty:0,
            thinkingLevel:null,
            enableThinking:true,
            omitTemperature:false,
            omitTopP:false,
            stopSequences:[],
            seed:null,
          },
        },
      ],
    },
  },
];

export function parseResearchConfigDefinition(input: unknown): ResearchConfigDefinition {
  return researchConfigDefinitionSchema.parse(input);
}

function comparePostgresJsonbKeys(left: string, right: string): number {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length - rightBytes.length || Buffer.compare(leftBytes, rightBytes);
}

export function serializeAsPostgresJsonb(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeAsPostgresJsonb).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(comparePostgresJsonbKeys);
    return `{${keys.map((key) => {
      if (record[key] === undefined) throw new TypeError('undefined is not valid JSON.');
      return `${JSON.stringify(key)}: ${serializeAsPostgresJsonb(record[key])}`;
    }).join(', ')}}`;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

export function hashResearchConfigDefinition(
  definition: ResearchConfigDefinition,
): string {
  const validated = parseResearchConfigDefinition(definition);
  return createHash('sha256')
    .update(serializeAsPostgresJsonb(validated))
    .digest('hex');
}
