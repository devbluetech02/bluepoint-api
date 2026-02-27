export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type AuthType = 'jwt' | 'api_key' | 'both' | 'none';

export interface FieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'date' | 'file';
  required?: boolean;
  description: string;
  example?: unknown;
  enum?: string[];
  items?: FieldSpec;
  properties?: Record<string, FieldSpec>;
}

export interface EndpointSpec {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  auth: AuthType;
  tags: string[];
  requestBody?: {
    required: boolean;
    contentType?: string;
    schema: Record<string, FieldSpec>;
    example: object;
  };
  queryParams?: Record<string, FieldSpec>;
  pathParams?: Record<string, FieldSpec>;
  responses: {
    success: { status: number; description: string; example: object };
    errors: Array<{ status: number; code: string; message: string }>;
  };
  tutorial?: string;
}

export interface CategorySpec {
  id: string;
  name: string;
  description: string;
  icon: string;
  endpoints: EndpointSpec[];
}
