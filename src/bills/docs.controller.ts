import { Controller, Get, Header, Res } from '@nestjs/common';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { join } from 'path';
import type { Response } from 'express';

/**
 * OpenAPI 文档端点（离线静态文档，避免引入额外依赖）：
 *  GET /api/docs/openapi.json
 */
@Controller('docs')
export class DocsController {
  private readonly specPath = join(process.cwd(), 'docs', 'openapi.json');

  @Get('openapi.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  openapi(@Res() res: Response): void {
    const stream: Readable = createReadStream(this.specPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ code: 'DOC_NOT_FOUND' });
      else res.end();
    });
    stream.pipe(res);
  }
}
