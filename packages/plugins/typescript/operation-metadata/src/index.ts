import { PluginFunction, Types } from '@graphql-codegen/plugin-helpers';
import { RawClientSideBasePluginConfig } from '@graphql-codegen/visitor-plugin-common';
import { glob } from 'glob';
import { GraphQLSchema, Kind, ListTypeNode, OperationDefinitionNode } from 'graphql';
import { GraphQLInputEnumTypeMetadata, GraphQLInputObjectFieldMetadata, GraphQLInputObjectFieldValidationMetadata, GraphQLInputObjectTypeMetadata, GraphQLInputTypeMetadata } from './GraphQLSchemaMetadata';
import { OperationGenerationMetadata, OperationParameterGenerationMetadata } from './OperationGenerationMetadata';

export interface OperationMetadataPluginConfig extends RawClientSideBasePluginConfig {
  metadata: string[],
}

export const plugin: PluginFunction<OperationMetadataPluginConfig, Types.PluginOutput> = async (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config: OperationMetadataPluginConfig
) => {
  if (!config.metadata || config.metadata.length === 0) {
    throw new Error('The metadata option is required and must be a glob pattern of json files.');
  }

  // get all the metadata files from the metadata path
  const schemaMetadataJson = await glob(config.metadata, { ignore: ['node_modules/**', '.graphql'] });

  // create the metadata object
  const metadata: GraphQLSchemaMetadata = {
    types: {
      input: {},
    },
  };

  // load and merge all the metadata into one file
  for (const jsonMetadata of schemaMetadataJson) {
    const module = await import(process.cwd() + '/' + jsonMetadata);
    Object.assign(metadata.types.input, module.types.input);
  }

  const operations: Array<OperationGenerationMetadata> = [];

  // loop through all the documents and create our new schema objects
  for (const document of documents) {
    // loop through all the definitions in the document
    for (const definition of document.document.definitions) {
      // if the definition is an operation definition
      if (definition.kind === 'OperationDefinition') {
        const operationMetadata = generateOperationMetadata(definition, metadata);
        if (operationMetadata) {
          operations.push(operationMetadata);
        }
      }
    }
  }

  // now use the metadata to generate the typescript code
  const result = generateTypescriptOperations(operations, metadata);
  return result;
};

function generateOperationMetadata(
  operationDefinition: OperationDefinitionNode,
  metadata: GraphQLSchemaMetadata
): OperationGenerationMetadata | null {
  // if the operation definition does not have variable definitions
  // (input parameters) there is nothing do to, return null
  if (!operationDefinition.variableDefinitions || operationDefinition.variableDefinitions.length === 0) {
    return null;
  }

  // get the operation name
  const operationName = operationDefinition.name.value;
  const parameters: Array<OperationParameterGenerationMetadata> = [];

  for (const variableDefinition of operationDefinition.variableDefinitions) {
    const variableName = variableDefinition.variable.name.value;
    let required = false;
    let kind: 'scalar' | 'enum' | 'object' | 'list' | undefined = undefined;
    let listRequiresItems = false;
    let variableType: string | undefined = undefined;
    const directives = variableDefinition.directives.map(d => d.name.value);

    if (variableDefinition.type.kind === Kind.NON_NULL_TYPE) {
      required = true;
      if (variableDefinition.type.type.kind === Kind.NAMED_TYPE) {
        variableType = variableDefinition.type.type.name.value;
      } else if (variableDefinition.type.type.kind === Kind.LIST_TYPE) {
        kind = 'list';
        const listResult = parseListType(variableDefinition.type.type);
        if (listResult) {
          variableType = listResult.itemType;
          listRequiresItems = listResult.requiresItems;
        }
      }
    } else if (variableDefinition.type.kind === Kind.NAMED_TYPE) {
      variableType = variableDefinition.type.name.value;
    } else if (variableDefinition.type.kind === Kind.LIST_TYPE) {
      kind = 'list';
      const listResult = parseListType(variableDefinition.type);
        if (listResult) {
          variableType = listResult.itemType;
          listRequiresItems = listResult.requiresItems;
        }
    } else {
      throw new Error(`Unsupported variable type ${variableDefinition.type}`);
    }

    if (!kind) {
      const typeMetadata = metadata.types.input[variableType];
      if (!typeMetadata) {
        throw new Error(`Type ${variableType} not found in schema metadata`);
      }
      kind = typeMetadata.kind;
    }

    const parameterMetedata = <OperationParameterGenerationMetadata>{
      parameter: variableName,
      required,
      directives,
      kind,
      type: variableType,
    };

    if (parameterMetedata.kind === 'list') {
      parameterMetedata.listRequiresItems = !listRequiresItems;
    }

    parameters.push(parameterMetedata);
  }

  return {
    operation: operationName,
    operationType: operationDefinition.operation,
    document: `${operationName}Document`,
    parameters,
  };
}

function parseListType(variableDefinition: ListTypeNode) {
  let requiresItems = false;
  let itemType: string | undefined = undefined;

  if (variableDefinition.type.kind === Kind.NAMED_TYPE) {
    itemType = variableDefinition.type.name.value;
  } else if (variableDefinition.type.kind === Kind.NON_NULL_TYPE) {
    requiresItems = true;
    if (variableDefinition.type.type.kind === Kind.NAMED_TYPE) {
      itemType = variableDefinition.type.type.name.value;
    } else {
      throw new Error(`Unsupported list item type ${variableDefinition.type.type.kind}`);
    }
  } else {
    throw new Error(`Unsupported list item type ${variableDefinition.type.kind}`);
  }

  return {
    requiresItems,
    itemType,
  };
}

function generateTypescriptOperations(
  operations: Array<OperationGenerationMetadata>,
  metadata: GraphQLSchemaMetadata
): string {
  const typesToGenerate = new Set<string>();
  const operationDefinitions: Array<string> = [];

  // First pass: collect all types we need to generate
  for (const operation of operations) {
    for (const parameter of operation.parameters) {
      collectTypeDependencies(parameter.type, metadata, typesToGenerate);
    }
    operationDefinitions.push(operationTemplate(operation, metadata));
  }

  // Topological sort: emit types in dependency order (dependencies first)
  const sortedTypes = topologicalSortTypes(typesToGenerate, metadata);

  // Generate type definitions in sorted order
  const typeDefinitions: string[] = [];
  for (const typeName of sortedTypes) {
    const typeMetadata = metadata.types.input[typeName];
    if (typeMetadata.kind === 'enum') {
      typeDefinitions.push(enumTypeTemplate(typeMetadata));
    } else if (typeMetadata.kind === 'object') {
      typeDefinitions.push(objectTypeTemplate(typeMetadata));
    }
  }

  return baseInputTypeTemplates() + '\n'
  + typeDefinitions.join('\n')
  + '\n'
  + baseOperationTemplates() + '\n'
  + operationDefinitions.join('\n');
}

function collectTypeDependencies(
  typeName: string,
  metadata: GraphQLSchemaMetadata,
  collected: Set<string>
) {
  if (collected.has(typeName)) {
    return;
  }

  const typeMetadata = metadata.types.input[typeName];
  if (!typeMetadata || typeMetadata.kind === 'scalar') {
    return;
  }

  collected.add(typeName);

  if (typeMetadata.kind === 'object') {
    for (const field of typeMetadata.fields) {
      if (field.kind === 'object' || field.kind === 'enum') {
        collectTypeDependencies(field.type, metadata, collected);
      }
    }
  }
}

function topologicalSortTypes(
  types: Set<string>,
  metadata: GraphQLSchemaMetadata
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // For cycle detection

  function visit(typeName: string) {
    if (visited.has(typeName)) {
      return;
    }
    if (visiting.has(typeName)) {
      // Cycle detected - just skip (shouldn't happen in valid GraphQL schemas)
      return;
    }

    const typeMetadata = metadata.types.input[typeName];
    if (!typeMetadata || typeMetadata.kind === 'scalar') {
      return;
    }

    visiting.add(typeName);

    // Visit dependencies first
    if (typeMetadata.kind === 'object') {
      for (const field of typeMetadata.fields) {
        if (field.kind === 'object' || field.kind === 'enum') {
          if (types.has(field.type)) {
            visit(field.type);
          }
        }
      }
    }

    visiting.delete(typeName);
    visited.add(typeName);
    result.push(typeName);
  }

  for (const typeName of types) {
    visit(typeName);
  }

  return result;
}

function baseOperationTemplates(): string {
  return `export interface GraphQLOperationMetadata<DocumentType> {
  readonly operation: string;
  readonly operationType: 'query' | 'mutation' | 'subscription';
  readonly document: DocumentType;
  readonly parameters?: ReadonlyArray<GraphQLOperationParameterMetadata>;
}

export type GraphQLOperationParameterMetadata =
  GraphQLOperationScalarParameterMetadata |
  GraphQLOperationUnitParameterMetadata |
  GraphQLOperationListParameterMetadata |
  GraphQLOperationScalarListParameterMetadata;

interface BaseGraphQLOperationParameterMetadata {
  readonly parameter: string;
  readonly required: boolean;
}

export interface GraphQLOperationScalarParameterMetadata extends BaseGraphQLOperationParameterMetadata {
  readonly kind: 'scalar';
  readonly type: string;
}

export interface GraphQLOperationUnitParameterMetadata extends BaseGraphQLOperationParameterMetadata {
  readonly kind: 'enum' | 'object';
  readonly type: GraphQLInputTypeMetadata;
}

interface BaseGraphQLOperationListParameterMetadata extends BaseGraphQLOperationParameterMetadata {
  readonly kind: 'list';
  readonly allowsEmpty: boolean;
}

export interface GraphQLOperationListParameterMetadata extends BaseGraphQLOperationListParameterMetadata {
  readonly itemKind: 'enum' | 'object';
  readonly type: GraphQLInputTypeMetadata;
}

export interface GraphQLOperationScalarListParameterMetadata extends BaseGraphQLOperationListParameterMetadata {
  readonly itemKind: 'scalar';
  readonly type: string;
}
`;
}

function baseInputTypeTemplates(): string {
  return `export type GraphQLInputTypeMetadata =
  GraphQLInputScalarTypeMetadata |
  GraphQLInputEnumTypeMetadata |
  GraphQLInputObjectTypeMetadata;

interface BaseGraphQLInputTypeMetadata {
  readonly type: string;
  readonly description?: string;
}

export interface GraphQLInputScalarTypeMetadata extends BaseGraphQLInputTypeMetadata {
  readonly kind: 'scalar';
}

export interface GraphQLInputEnumTypeMetadata extends BaseGraphQLInputTypeMetadata {
  readonly kind: 'enum';
  readonly values: Array<string>;
}

export interface GraphQLInputObjectTypeMetadata extends BaseGraphQLInputTypeMetadata {
  readonly kind: 'object';
  readonly fields: ReadonlyArray<GraphQLInputObjectFieldMetadata>;
}

export type GraphQLInputObjectFieldMetadata =
  GraphQLInputObjectScalarFieldMetadata |
  GraphQLInputObjectEnumFieldMetadata |
  GraphQLInputObjectObjectFieldMetadata |
  GraphQLInputObjectListFieldMetadata |
  GraphQLInputObjectScalarListFieldMetadata;

interface BaseGraphQLInputObjectFieldMetadata {
  readonly name: string;
  readonly required: boolean;
  readonly validation?: ReadonlyArray<GraphQLInputObjectFieldValidationMetadata>;
}

export interface GraphQLInputObjectScalarFieldMetadata extends BaseGraphQLInputObjectFieldMetadata {
  readonly kind: 'scalar';
  readonly type: string;
}

export interface GraphQLInputObjectEnumFieldMetadata extends BaseGraphQLInputObjectFieldMetadata {
  readonly kind: 'enum';
  readonly type: GraphQLInputEnumTypeMetadata;
}

export interface GraphQLInputObjectObjectFieldMetadata extends BaseGraphQLInputObjectFieldMetadata {
  readonly kind: 'object';
  readonly type: GraphQLInputObjectTypeMetadata;
}

interface BaseGraphQLInputObjectListFieldMetadata extends BaseGraphQLInputObjectFieldMetadata {
  readonly kind: 'list';
  readonly allowsEmpty: boolean;
}

export interface GraphQLInputObjectListFieldMetadata extends BaseGraphQLInputObjectListFieldMetadata {
  readonly itemKind: 'enum' | 'object';
  readonly type: GraphQLInputTypeMetadata;
}

export interface GraphQLInputObjectScalarListFieldMetadata extends BaseGraphQLInputObjectListFieldMetadata {
  readonly itemKind: 'scalar';
  readonly type: string;
}

export interface GraphQLInputObjectFieldValidationMetadata {
  readonly type: string;
  readonly constraints?: ReadonlyArray<any>;
  readonly each?: boolean;
  readonly context?: any;
  readonly options?: any;
}
`;
}

// Helper to generate export name without doubling "Input"
// e.g., "PostCreateInput" -> "PostCreateInputMetadata" (not "PostCreateInputInputMetadata")
// e.g., "RichContentFormat" -> "RichContentFormatMetadata"
function getExportName(typeName: string): string {
  if (typeName.endsWith('Input')) {
    return `${typeName}Metadata`;
  }
  return `${typeName}Metadata`;
}

function enumTypeTemplate(type: GraphQLInputEnumTypeMetadata): string {
  return `export const ${getExportName(type.type)}: GraphQLInputEnumTypeMetadata = {
  kind: 'enum',
  type: '${type.type}',
  values: [${type.values.map(v => '\n    ' + `'${v}'`).join(',')}\n  ],
};
`;
}

function objectTypeTemplate(type: GraphQLInputObjectTypeMetadata): string {
  return `export const ${getExportName(type.type)}: GraphQLInputObjectTypeMetadata = {
  kind: 'object',
  type: '${type.type}',
  fields: [${type.fields.map(f => '\n  ' + fieldTemplate(f)).join(',')}\n  ],
};
`;
}

function fieldTemplate(field: GraphQLInputObjectFieldMetadata): string {
  if (field.validation && field.validation.length > 0) {
    return `{
      name: '${field.name}',
      kind: '${field.kind}',
      type: ${getFieldType(field)},
      required: ${field.required},
      validation: [${field.validation.map(v => '\n      ' + validationTemplate(v)).join(',')}\n      ],
    }`;
  }

  return `{
      name: '${field.name}',
      kind: '${field.kind}',
      type: ${getFieldType(field)},
      required: ${field.required},
    }`;
}

function getFieldType(field: GraphQLInputObjectFieldMetadata): string {
  if (field.kind === 'scalar') {
    return `'${field.type}'`;
  }
  return getExportName(field.type);
}

function validationTemplate(validation: GraphQLInputObjectFieldValidationMetadata): string {
  if (validation.constraints && validation.constraints.length > 0) {
    return `  {
            type: '${validation.type}',
            constraints: [${validation.constraints.map(c => '\n              ' + JSON.stringify(c)).join(',')}\n            ],
          }`;
  }

  return `  {
            type: '${validation.type}',
          }`;
}

function operationTemplate(
  operation: OperationGenerationMetadata,
  metadata: GraphQLSchemaMetadata
): string {
  return `export const ${operation.operation}Operation: GraphQLOperationMetadata<typeof ${operation.document}> = {
  operation: '${operation.operation}',
  operationType: '${operation.operationType}',
  document: ${operation.document},
  parameters: [${operation.parameters.map(p => parameterTemplate(p, metadata)).join(',')},
  ],
}
  `;
}

function parameterTemplate(
  parameter: OperationParameterGenerationMetadata,
  metadata: GraphQLSchemaMetadata
): string {
  if (parameter.kind === 'scalar') {
    return `
    {
      parameter: '${parameter.parameter}',
      required: ${parameter.required},
      kind: '${parameter.kind}',
      type: '${parameter.type}',
    }`;
  } else if (parameter.kind === 'list') {
    const typeMetadata = metadata.types.input[parameter.type];
    return `
    {
      parameter: '${parameter.parameter}',
      required: ${parameter.required},
      kind: '${parameter.kind}',
      itemKind: '${typeMetadata.kind}',
      type: ${getParameterType(typeMetadata.kind, parameter.type)},
      allowsEmpty: ${parameter.listRequiresItems},
    }`;
  }

  return `
    {
      parameter: '${parameter.parameter}',
      required: ${parameter.required},
      kind: '${parameter.kind}',
      type: ${getExportName(parameter.type)},
    }`;
}

function getParameterType(kind: 'object' | 'enum' | 'scalar', type: string): string {
  if (kind === 'scalar') {
    return `'${type}'`;
  }
  return getExportName(type);
}

interface GraphQLSchemaMetadata {
  types: {
      input: Record<string, GraphQLInputTypeMetadata>;
  };
}
