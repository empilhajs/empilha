import type { TSchema } from "@sinclair/typebox";

export type OpenApiSchema =
  | TSchema
  | {
      type: "string" | "number" | "boolean";
    };

export type OpenApiParameter = {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: OpenApiSchema;
};

export type OpenApiResponse = {
  description: string;
  content?: Record<string, { schema?: TSchema }>;
};

export type OpenApiOperation = {
  operationId: string;
  tags: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: true;
    content: {
      "application/json": { schema: TSchema };
    };
  };
  responses: Record<string, OpenApiResponse>;
  security?: Array<{ bearerAuth: [] }>;
};

export type OpenApiComponents = {
  securitySchemes?: {
    bearerAuth: {
      type: "http";
      scheme: "bearer";
      bearerFormat: "JWT";
    };
  };
  schemas?: Record<string, TSchema>;
};
