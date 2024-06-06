import { GraphQLFileLoader } from '@graphql-tools/graphql-file-loader';
import { loadDocumentsSync } from '@graphql-tools/load';
import { loadFilesSync } from '@graphql-tools/load-files';
import { mergeTypeDefs } from '@graphql-tools/merge';
import * as fs from 'fs';
import { DocumentNode, buildSchema, print } from 'graphql';
import { plugin } from '../src';

describe('Operation Metadata Plugin Test', () => {
  // Load all the schemas as graphql files from the schema folder
  const typesArray = loadFilesSync('./packages/plugins/typescript/operation-metadata/test-data/schemas/',
    { recursive: true, ignoredExtensions: ['json'] }
  );
  // Merge all the schemas into a single schema
  const typeDefs: DocumentNode = mergeTypeDefs(typesArray);
  // Convert the schema to a string
  const stringy = print(typeDefs);
  // Build the schema from the string
  const schema = buildSchema(stringy);

  // Load all the documents as graphql files from the documents folder
  const documents = loadDocumentsSync('./packages/plugins/typescript/operation-metadata/test-data/documents/*.graphql',
    { loaders: [new GraphQLFileLoader()] }
  );

  it('Generates the correct output file', async () => {
    const result = await plugin(schema, documents, {
      metadata: [
        './packages/plugins/typescript/operation-metadata/test-data/**/*.json'
      ],
    });

    expect(typeof result).toBe('string');
    expect(result).toBeDefined();

    if (typeof result === 'string') {
      const filePath = './packages/plugins/typescript/operation-metadata/test-data/operations.ts';
      fs.writeFileSync(filePath, result);
      console.log(`Wrote output to file: ${filePath}`);
    }
  })
});
