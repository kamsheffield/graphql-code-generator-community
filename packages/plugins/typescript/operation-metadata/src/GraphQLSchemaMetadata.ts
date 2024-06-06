export type GraphQLInputTypeMetadata = GraphQLInputScalarTypeMetadata | GraphQLInputEnumTypeMetadata | GraphQLInputObjectTypeMetadata;

interface BaseGraphQLInputTypeMetadata {
  type: string;
  description?: string;
}

export interface GraphQLInputScalarTypeMetadata extends BaseGraphQLInputTypeMetadata {
  kind: 'scalar';
}

export interface GraphQLInputEnumTypeMetadata extends BaseGraphQLInputTypeMetadata {
  kind: 'enum';
  values: Array<string>;
}

export interface GraphQLInputObjectTypeMetadata extends BaseGraphQLInputTypeMetadata {
  kind: 'object';
  fields: Array<GraphQLInputObjectFieldMetadata>;
}

/**
* The metadata for a field in a GraphQL type.
*/
export interface GraphQLInputObjectFieldMetadata {

  name: string;

  kind: 'object' | 'scalar' | 'enum' | 'list';

  type: string;

  required: boolean;

  /**
   * The validation for the field.
   */
  validation?: GraphQLInputObjectFieldValidationMetadata[];
}

export interface GraphQLInputObjectListFieldMetadata extends GraphQLInputObjectFieldMetadata {
  kind: 'list';
  allowsEmpty: boolean;
}

export interface GraphQLInputObjectFieldValidationMetadata {

  /**
   * The type of the validation.
   */
  type: string;

  /**
   * Array of constraints of this validation.
   */
  constraints?: any[];

  /**
   * Specifies if validated value is an array and each of its item must be validated.
   */
  each?: boolean;

  /*
   * A transient set of data passed through to the validation result for response mapping
   */
  context?: any;

  /**
   * Extra options specific to validation type.
   */
  options?: any;
}
