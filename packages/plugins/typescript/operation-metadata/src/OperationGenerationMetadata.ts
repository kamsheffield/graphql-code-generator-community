
export type OperationParameterGenerationMetadata = OperationUnitParameterGenerationMetadata | OperationListParameterGenerationMetadata;

interface BaseOperationParameterGenerationMetadata {
  parameter: string;
  required: boolean;
  directives: String[];
  type: string;
}

export interface OperationUnitParameterGenerationMetadata extends BaseOperationParameterGenerationMetadata {
  kind: 'scalar' | 'enum' | 'object';
}

export interface OperationListParameterGenerationMetadata extends BaseOperationParameterGenerationMetadata{
  kind: 'list';
  listRequiresItems: boolean
}

export interface OperationGenerationMetadata {
  operation: string;
  operationType: 'query' | 'mutation' | 'subscription';
  document: string;
  parameters: Array<OperationParameterGenerationMetadata>;
}
