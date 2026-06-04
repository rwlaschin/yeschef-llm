import Ajv, { JSONSchemaType } from 'ajv'

const ajv = new Ajv()

// Tool parameter property schema
interface ParameterProperty {
  type: string
  description: string
  enum?: string[]
  default?: any
}

// Tool definition schema (what goes into definition field)
interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ParameterProperty>
    required: string[]
  }
}

// Full tool document schema
interface Tool {
  name: string
  version: number
  active: boolean
  isDeleted: boolean
  definition: ToolDefinition
}

// Schema for creating/updating tools (without version, isDeleted, timestamps)
interface ToolInput {
  name: string
  active: boolean
  definition: ToolDefinition
}

const toolDefinitionSchema: JSONSchemaType<ToolDefinition> = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'object' },
        properties: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              description: { type: 'string' },
              enum: { type: 'array', items: { type: 'string' } },
              default: {}
            },
            required: ['type', 'description']
          }
        },
        required: {
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['type', 'properties', 'required']
    }
  },
  required: ['name', 'description', 'parameters']
}

const toolInputSchema: JSONSchemaType<ToolInput> = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    active: { type: 'boolean' },
    definition: toolDefinitionSchema
  },
  required: ['name', 'active', 'definition']
}

export const validateTool = ajv.compile(toolInputSchema)
export const validateToolDefinition = ajv.compile(toolDefinitionSchema)

export type { Tool, ToolInput, ToolDefinition }
