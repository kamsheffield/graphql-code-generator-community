# GraphQL Codegen Tree-Shaking Issue

## Summary

The `typescript-operation-metadata` plugin generates code using TypeScript namespaces, which
prevents tree-shaking. When a consumer imports a single type like
`GraphQLInputTypes.AccountProfileUpdateInput`, the entire namespace (~1600 lines, 60+ exports) gets
bundled.

## Current Generated Code Structure

The plugin generates code in `libraries/structure/source/api/graphql/generated/graphql.ts`:

```typescript
// Lines 4442-6035 (~1600 lines)
export namespace GraphQLInputTypes {
  export const SupportTicketStatus: GraphQLInputEnumTypeMetadata = {
    kind: 'enum',
    type: 'SupportTicketStatus',
    values: ['Open', 'Closed', 'Deleted']
  }

  export const SupportTicketCommentVisibility: GraphQLInputEnumTypeMetadata = {
    kind: 'enum',
    type: 'SupportTicketCommentVisibility',
    values: ['Public', 'Internal']
  }

  export const SupportTicketCommentCreateInput: GraphQLInputObjectTypeMetadata = {
    kind: 'object',
    type: 'SupportTicketCommentCreateInput',
    fields: [
      {
        name: 'ticketIdentifier',
        kind: 'scalar',
        type: 'String',
        required: true
      },
      {
        name: 'contentType',
        kind: 'enum',
        type: GraphQLInputTypes.RichContentFormat, // <-- Internal cross-reference
        required: false
      },
      {
        name: 'visibility',
        kind: 'enum',
        type: GraphQLInputTypes.SupportTicketCommentVisibility, // <-- Internal cross-reference
        required: false
      }
    ]
  }

  // ... 60+ more exports
}
```

## Why Namespaces Break Tree-Shaking

TypeScript namespaces compile to an IIFE (Immediately Invoked Function Expression) that creates a
single object:

```javascript
// What TypeScript compiles the namespace to:
export var GraphQLInputTypes
;(function (GraphQLInputTypes) {
  GraphQLInputTypes.SupportTicketStatus = {
    kind: 'enum',
    type: 'SupportTicketStatus',
    values: ['Open', 'Closed', 'Deleted']
  }
  GraphQLInputTypes.SupportTicketCommentVisibility = {
    kind: 'enum'
    // ...
  }
  // ALL 60+ exports are attached to this single object
})(GraphQLInputTypes || (GraphQLInputTypes = {}))
```

**The problem**: Bundlers (webpack, esbuild, rollup) cannot tree-shake properties off of objects.
When you import `GraphQLInputTypes`, you get the entire object with all 60+ properties, even if you
only access one.

## Consumer Usage Example

In `libraries/structure/source/modules/account/profile/profile/components/ProfileDetailsForm.tsx`:

```typescript
import { GraphQLInputTypes } from '@structure/source/api/graphql/GraphQlGeneratedCode'

// We only need AccountProfileUpdateInput, but we get ALL 60+ types bundled
const profileInformationSchema = schemaFromGraphQl(GraphQLInputTypes.AccountProfileUpdateInput, [
  'givenName',
  'familyName',
  'displayName'
])
```

## Proposed Solution: Top-Level Exports

Change the codegen to emit top-level `const` exports instead of a namespace. Top-level exports are
fully tree-shakeable by all modern bundlers.

### Before (Current - Not Tree-Shakeable)

```typescript
export namespace GraphQLInputTypes {
  export const SupportTicketStatus: GraphQLInputEnumTypeMetadata = {
    kind: 'enum',
    type: 'SupportTicketStatus',
    values: ['Open', 'Closed', 'Deleted']
  }

  export const SupportTicketCommentCreateInput: GraphQLInputObjectTypeMetadata = {
    kind: 'object',
    type: 'SupportTicketCommentCreateInput',
    fields: [
      {
        name: 'visibility',
        kind: 'enum',
        type: GraphQLInputTypes.SupportTicketCommentVisibility, // Namespace reference
        required: false
      }
    ]
  }
}
```

### After (Proposed - Tree-Shakeable)

```typescript
export const SupportTicketStatusInputType: GraphQLInputEnumTypeMetadata = {
  kind: 'enum',
  type: 'SupportTicketStatus',
  values: ['Open', 'Closed', 'Deleted']
}

export const SupportTicketCommentCreateInputType: GraphQLInputObjectTypeMetadata = {
  kind: 'object',
  type: 'SupportTicketCommentCreateInput',
  fields: [
    {
      name: 'visibility',
      kind: 'enum',
      type: SupportTicketCommentVisibilityInputType, // Direct reference (hoisted)
      required: false
    }
  ]
}
```

## Key Changes Required in the Plugin

### 1. Replace Namespace with Top-Level Exports

Instead of wrapping everything in `export namespace GraphQLInputTypes { ... }`, emit each type as a
standalone `export const`.

### 2. Add Suffix to Avoid Naming Collisions

The generated types (like `SupportTicketStatus`) already exist as TypeScript type definitions
earlier in the file. To avoid collisions, add a suffix like `InputType`:

- `SupportTicketStatus` → `SupportTicketStatusInputType`
- `AccountProfileUpdateInput` → `AccountProfileUpdateInputType`

### 3. Update Internal Cross-References

Change references from `GraphQLInputTypes.SomeName` to just `SomeNameInputType`:

```typescript
// Before
type: GraphQLInputTypes.RichContentFormat

// After
type: RichContentFormatInputType
```

This works because JavaScript hoists `const` declarations (the binding, not the initialization), and
the order of exports in the generated file ensures dependencies are defined before they're
referenced.

### 4. Handle Declaration Order (Important!)

Since types can reference each other, the plugin needs to either:

**Option A**: Emit types in dependency order (enums first, then objects that reference them)

**Option B**: Use lazy evaluation (less ideal for our use case)

Looking at the current generated code, it appears enums are already emitted before objects that
reference them, so Option A should work naturally.

## Operations Section Impact

The operations section (lines 6037+) also references the namespace:

```typescript
export const SupportTicketUpdateStatusPrivilegedOperation: GraphQLOperationMetadata<...> = {
    operation: 'SupportTicketUpdateStatusPrivileged',
    operationType: 'mutation',
    document: SupportTicketUpdateStatusPrivilegedDocument,
    parameters: [
        {
            parameter: 'status',
            required: true,
            kind: 'enum',
            type: GraphQLInputTypes.SupportTicketStatus,  // <-- Needs to change
        },
    ],
};
```

These would need to be updated to use the new direct references:

```typescript
type: SupportTicketStatusInputType,  // Direct import reference
```

## Migration Path for Consumers

After the plugin is updated, consumer code changes from:

```typescript
// Before
import { GraphQLInputTypes } from '@structure/source/api/graphql/GraphQlGeneratedCode';
const schema = schemaFromGraphQl(GraphQLInputTypes.AccountProfileUpdateInput, [...]);

// After
import { AccountProfileUpdateInputType } from '@structure/source/api/graphql/GraphQlGeneratedCode';
const schema = schemaFromGraphQl(AccountProfileUpdateInputType, [...]);
```

## Alternative Approaches Considered

### 1. Separate Files Per Type

Generate each type in its own file with a barrel export. Maximum tree-shakeability but creates many
files and more complex import management.

### 2. Keep Namespace + Add Individual Exports

Export both the namespace (for backwards compatibility) and individual exports. Downside: consumers
might accidentally use the non-tree-shakeable namespace import.

### 3. Use a Map/Registry Pattern

```typescript
export const GraphQLInputTypeRegistry = new Map([
    ['SupportTicketStatus', { kind: 'enum', ... }],
]);
```

This is still not tree-shakeable since it's a single Map.

## Recommendation

The top-level exports approach (Option 1 in "Proposed Solution") is the cleanest solution:

1. **Minimal plugin changes**: Replace namespace wrapper with direct exports, add suffix, update
   cross-references
2. **Full tree-shaking**: Bundlers can eliminate unused exports completely
3. **Clean consumer API**: Direct named imports are idiomatic ES modules
4. **No runtime overhead**: No additional abstractions or registries

## File Locations

- **Codegen config**: `libraries/structure/source/api/graphql/GraphQlCodeGeneratorConfiguration.ts`
- **Generated output**: `libraries/structure/source/api/graphql/generated/graphql.ts`
- **Plugin source**: `@graphql-codegen/typescript-operation-metadata` (Kam's fork)
- **Re-export barrel**: `libraries/structure/source/api/graphql/GraphQlGeneratedCode.ts`

## Questions for Implementation

1. **Suffix choice**: Is `InputType` suffix acceptable, or prefer something else like
   `InputMetadata` or `GraphQLInput`?

2. **Backwards compatibility**: Do we need to maintain the namespace export temporarily for
   migration, or can we do a clean break?

3. **Operation metadata**: Should the operation metadata objects (like
   `AccountProfileUpdateOperation`) also become tree-shakeable top-level exports, or are they
   already fine since they're outside the namespace?
