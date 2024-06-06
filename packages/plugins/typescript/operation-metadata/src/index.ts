import { PluginFunction, Types } from '@graphql-codegen/plugin-helpers';
import { RawClientSideBasePluginConfig } from '@graphql-codegen/visitor-plugin-common';
import { glob } from 'glob';
import { GraphQLSchema, Kind, ListTypeNode, OperationDefinitionNode } from 'graphql';
import { GraphQLInputEnumTypeMetadata, GraphQLInputObjectFieldMetadata, GraphQLInputObjectFieldValidationMetadata, GraphQLInputObjectTypeMetadata, GraphQLInputTypeMetadata } from './GraphQLSchemaMetadata';
import { OperationGenerationMetadata, OperationParameterGenerationMetadata } from './OperationGenerationMetadata';

export interface OperationMetadataPluginConfig extends RawClientSideBasePluginConfig {
  metadataPath: string,
}

export const plugin: PluginFunction<OperationMetadataPluginConfig, Types.PluginOutput> = async (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config: OperationMetadataPluginConfig
) => {
  // get all the metadata files from the metadata path
  const schemaMetadataJson = await glob(config.metadataPath + '/**/*.json', { ignore: ['node_modules/**', '.graphql'] });

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
  const typeDefinitions: Record<string, string> = {};
  const operationDefinitions: Array<string> = [];

  for (const operation of operations) {
    //
    for (const parameter of operation.parameters) {
      // if the type is already defined, we don't need to do anything
      if (typeDefinitions[parameter.type]) {
        continue;
      }
      generateTypescriptType(parameter, metadata, typeDefinitions);
    }
    operationDefinitions.push(operationTemplate(operation, metadata));
  }

  return baseInputTypeTemplates() + '\n'
  + 'export namespace GraphQLInputTypes {\n\n'
  + Object.values(typeDefinitions).reverse().join('\n')
  + '}\n\n'
  + baseOperationTemplates() + '\n'
  + operationDefinitions.join('\n');
}

function generateTypescriptType(
  parameter: { type: string},
  metadata: GraphQLSchemaMetadata,
  typeDefinitions: Record<string, string>
) {
  if (typeDefinitions[parameter.type]) {
    return;
  }

  // get the type metadata
  const typeMetadata = metadata.types.input[parameter.type];
  if (!typeMetadata) {
    throw new Error(`Type ${parameter.type} not found in schema metadata`);
  }

  if (typeMetadata.kind === 'object') {
    typeDefinitions[typeMetadata.type] = objectTypeTemplate(typeMetadata);
    // recurse through the fields
    for (const field of typeMetadata.fields) {
      if (field.kind === 'object') {
        // get the type metadata for the object
        const fieldTypeMetadata = metadata.types.input[field.type];
        generateTypescriptType(fieldTypeMetadata, metadata, typeDefinitions);
      } else if (field.kind === 'enum') {
        // get the type metadata for the enum
        const enumTypeMetadata = metadata.types.input[field.type];
        generateTypescriptType(enumTypeMetadata, metadata, typeDefinitions);
        //typeDefinitions[field.type] = enumTypeTemplate(enumTypeMetadata as GraphQLInputEnumTypeMetadata);
      }
      // do nothing for scalar types
    }
  } else if (typeMetadata.kind === 'enum') {
    typeDefinitions[typeMetadata.type] = enumTypeTemplate(typeMetadata);
  }
  // do nothing for scalar types
}

function baseOperationTemplates(): string {
  return `export interface GraphQLOperationMetadata<DocumentType> {
  readonly operation: string;
  readonly operationType: 'query' | 'mutation' | 'subscription';
  readonly document: DocumentType;
  readonly parameters?: ReadonlyArray<GraphQLOperationParameterMetadata>;
}

export type GraphQLOperationParameterMetadata = GraphQLOperationScalarParameterMetadata | GraphQLOperationUnitParameterMetadata | GraphQLOperationListParameterMetadata;

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

export interface GraphQLOperationListParameterMetadata extends BaseGraphQLOperationParameterMetadata {
  readonly kind: 'list';
  readonly type: GraphQLInputTypeMetadata;
  readonly allowsEmpty: boolean;
}
`;
}

function baseInputTypeTemplates(): string {
  return `export type GraphQLInputTypeMetadata = GraphQLInputScalarTypeMetadata | GraphQLInputEnumTypeMetadata | GraphQLInputObjectTypeMetadata;

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

export type GraphQLInputObjectFieldMetadata = GraphQLInputObjectScalarFieldMetadata | GraphQLInputObjectUnitFieldMetadata | GraphQLInputObjectListFieldMetadata;

/**
* The metadata for a field in a GraphQL type.
*/
interface BaseGraphQLInputObjectFieldMetadata {
  readonly name: string;
  readonly required: boolean;
  readonly validation?: ReadonlyArray<GraphQLInputObjectFieldValidationMetadata>;
}

export interface GraphQLInputObjectScalarFieldMetadata extends BaseGraphQLInputObjectFieldMetadata {
  readonly kind: 'scalar';
  readonly type: string;
}

export interface GraphQLInputObjectUnitFieldMetadata extends BaseGraphQLInputObjectFieldMetadata {
  readonly kind: 'enum' | 'object';
  readonly type: GraphQLInputEnumTypeMetadata;
}

export interface GraphQLInputObjectListFieldMetadata extends BaseGraphQLInputObjectFieldMetadata {
  readonly kind: 'list';
  readonly itemKind: 'scalar' | 'enum' | 'object';
  readonly type: string | GraphQLInputTypeMetadata;
  readonly allowsEmpty: boolean;
}

export interface GraphQLInputObjectFieldValidationMetadata {

  /**
   * The type of the validation.
   */
  readonly type: string;

  /**
   * Array of constraints of this validation.
   */
  readonly constraints?: ReadonlyArray<any>;

  /**
   * Specifies if validated value is an array and each of its item must be validated.
   */
  readonly each?: boolean;

  /*
   * A transient set of data passed through to the validation result for response mapping
   */
  readonly context?: any;

  /**
   * Extra options specific to validation type.
   */
  readonly options?: any;
}
`;
}

function enumTypeTemplate(type: GraphQLInputEnumTypeMetadata): string {
  return `  export const ${type.type} = <GraphQLInputEnumTypeMetadata>{
    kind: 'enum',
    type: '${type.type}',
    values: [${type.values.map(v => '\n      ' + `'${v}'`).join(',')}\n    ],
  }
`;
}

function objectTypeTemplate(type: GraphQLInputObjectTypeMetadata): string {
  return `  export const ${type.type} = <GraphQLInputObjectTypeMetadata>{
    kind: 'object',
    type: '${type.type}',
    fields: [${type.fields.map(f => '\n    ' + fieldTemplate(f)).join(',')}\n    ],
  }
`;
}

function fieldTemplate(field: GraphQLInputObjectFieldMetadata): string {
  if (field.validation && field.validation.length > 0) {
    return `  {
        name: '${field.name}',
        kind: '${field.kind}',
        type: ${getFieldType(field)},
        required: ${field.required},
        validation: [${field.validation.map(v => '\n        ' + validationTemplate(v)).join(',')}\n        ],
      }`;
  }

  return `  {
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
  return `GraphQLInputTypes.${field.type}`;
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
  return `export const ${operation.operation}Operation = <GraphQLOperationMetadata<typeof ${operation.document}>>{
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
    if (typeMetadata.kind === 'scalar') {
      return `
    {
      parameter: '${parameter.parameter}',
      required: ${parameter.required},
      kind: '${parameter.kind}',
      type: '${parameter.type}',
      allowsEmpty: ${parameter.listRequiresItems},
    }`;
    }
    return `
    {
      parameter: '${parameter.parameter}',
      required: ${parameter.required},
      kind: '${parameter.kind}',
      type: GraphQLInputTypes.${parameter.type},
      allowsEmpty: ${parameter.listRequiresItems},
    }`;
  }

  return `
    {
      parameter: '${parameter.parameter}',
      required: ${parameter.required},
      kind: '${parameter.kind}',
      type: GraphQLInputTypes.${parameter.type},
    }`;
}

interface GraphQLSchemaMetadata {
  types: {
      input: Record<string, GraphQLInputTypeMetadata>;
  };
}
