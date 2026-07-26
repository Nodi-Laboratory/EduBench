import { describe, expect, test } from 'vitest';
import {
  benchmarkModelsResearchConfigSchema,
  defaultResearchConfigDefinitions,
  documentParseResearchConfigSchema,
  embeddingRagResearchConfigSchema,
  hashResearchConfigDefinition,
  parseResearchConfigDefinition,
  serializeAsPostgresJsonb,
} from '@/domain/research-config';

describe('research configuration definitions', () => {
  test('publishes four strict, researcher-readable presets with the current safe defaults', () => {
    expect(defaultResearchConfigDefinitions).toHaveLength(4);
    expect(defaultResearchConfigDefinitions.map((profile) => profile.kind)).toEqual([
      'document_parse',
      'embedding_rag',
      'question_generation',
      'benchmark_models',
    ]);

    expect(defaultResearchConfigDefinitions[0]).toMatchObject({
      kind:'document_parse',
      settings:{
        model:'document-parse',
        mode:'enhanced',
        ocr:'force',
        outputFormat:'html',
        base64Encoding:['table', 'figure', 'chart', 'equation'],
        rasterization:{ format:'png', lossless:true, dpi:300 },
      },
    });
    expect(defaultResearchConfigDefinitions[1]).toMatchObject({
      kind:'embedding_rag',
      version:'embedding-rag-gemini-embedding-2-3072-text-prefix-v1',
      settings:{
        model:'gemini-embedding-2',
        dimensions:3072,
        vectorSpaceId:'gemini-embedding-2:3072:text-prefix-prerequisite-rag-v1',
        documentTaskType:'RETRIEVAL_DOCUMENT',
        queryTaskType:'RETRIEVAL_QUERY',
        prefixStrategy:'text_prefix',
        documentPrefix:'title: none | text: ',
        queryPrefix:'task: search result | query: ',
      },
    });
    expect(defaultResearchConfigDefinitions[2]).toMatchObject({
      kind:'question_generation',
      settings:{
        model:'gemini-3.6-flash',
        directionMaxOutputTokens:2048,
        questionMaxOutputTokens:16384,
      },
    });
    expect(defaultResearchConfigDefinitions[3]).toMatchObject({
      kind:'benchmark_models',
      settings:{
        models:[
          { providerKey:'gemini', modelId:'gemini-3.6-flash' },
          { providerKey:'upstage', modelId:'solar-pro3' },
          {
            providerKey:'exaone',
            modelId:'LGAI-EXAONE/K-EXAONE-236B-A23B',
            generation:{ temperature:1, topP:0.95, presencePenalty:0, enableThinking:true, maxOutputTokens:16384 },
          },
        ],
      },
    });

    for (const profile of defaultResearchConfigDefinitions) {
      expect(parseResearchConfigDefinition(profile)).toEqual(profile);
      expect(profile.description.length).toBeGreaterThan(20);
      expect(profile.applyScope.length).toBeGreaterThan(20);
      expect(profile.reprocessingImpact.length).toBeGreaterThan(20);
    }
  });

  test('rejects unknown deployment secrets and unsupported settings instead of silently stripping them', () => {
    const parserWithSecret = {
      ...structuredClone(documentParseResearchConfigSchema.parse(
        defaultResearchConfigDefinitions.find((profile) => profile.kind === 'document_parse'),
      )),
      baseUrl:'https://example.invalid',
    };
    expect(() => parseResearchConfigDefinition(parserWithSecret)).toThrow();

    const embedding = embeddingRagResearchConfigSchema.parse(
      defaultResearchConfigDefinitions.find((profile) => profile.kind === 'embedding_rag'),
    );
    expect(parseResearchConfigDefinition({
      ...embedding,
      version:'embedding-rag-1536-v1',
      settings:{
        ...embedding.settings,
        dimensions:1536,
        vectorSpaceId:'gemini-embedding-2:1536:text-prefix-test-v1',
      },
    })).toMatchObject({
      kind:'embedding_rag',
      settings:{ dimensions:1536 },
    });
    expect(() => parseResearchConfigDefinition({
      ...embedding,
      settings:{ ...embedding.settings, dimensions:64 },
    })).toThrow();

    const parser = documentParseResearchConfigSchema.parse(
      defaultResearchConfigDefinitions.find((profile) => profile.kind === 'document_parse'),
    );
    expect(() => parseResearchConfigDefinition({
      ...parser,
      settings:{ ...parser.settings, base64Encoding:['table', 'figure', 'chart'] },
    })).toThrow();
    expect(() => parseResearchConfigDefinition({
      ...parser,
      settings:{
        ...parser.settings,
        base64Encoding:['table', 'figure', 'chart', 'equation', 'table'],
      },
    })).toThrow();

    const benchmark = structuredClone(benchmarkModelsResearchConfigSchema.parse(
      defaultResearchConfigDefinitions.find((profile) => profile.kind === 'benchmark_models'),
    ));
    benchmark.settings.models[2]!.generation.topP = 1.1;
    expect(() => parseResearchConfigDefinition(benchmark)).toThrow();
  });

  test('serializes with PostgreSQL jsonb ordering and produces a stable SHA-256 digest', () => {
    expect(serializeAsPostgresJsonb({
      schemaVersion:1,
      kind:'probe',
      settings:{
        temperature:0.7,
        arr:['a', '한글'],
        enabled:true,
        empty:null,
      },
    })).toBe(
      '{"kind": "probe", "settings": {"arr": ["a", "한글"], "empty": null, "enabled": true, "temperature": 0.7}, "schemaVersion": 1}',
    );

    expect(hashResearchConfigDefinition(defaultResearchConfigDefinitions[0]))
      .toMatch(/^[0-9a-f]{64}$/);
    expect(hashResearchConfigDefinition(defaultResearchConfigDefinitions[0]))
      .toBe(hashResearchConfigDefinition(structuredClone(defaultResearchConfigDefinitions[0])));
  });
});
