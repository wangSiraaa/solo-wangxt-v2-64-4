import { Controller, Get, Header } from '@nestjs/common';
import { buildOpenApiDocument } from './openapi.document';

@Controller()
export class OpenApiController {
  /** OpenAPI 3.0 描述文档（程序化构建，零额外依赖） */
  @Get('openapi.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  document(): Record<string, unknown> {
    return buildOpenApiDocument();
  }
}
