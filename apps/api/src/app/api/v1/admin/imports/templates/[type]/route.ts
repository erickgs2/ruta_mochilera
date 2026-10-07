import { importTemplate, type ImportType } from '@rm/domain-imports';
import { fail, ok } from '@rm/shared-utils';
import { route } from '../../../../../../../lib/http/route';
import { problemResponse } from '../../../../../../../lib/http/problem';

const TYPES: Record<string, ImportType> = { customers: 'CUSTOMERS', payments: 'PAYMENTS' };

/** Downloads an import template: the header row and one example row, as CSV. */
export const GET = route({
  permission: 'import.manage',
  handler: async ({ params }) => {
    const type = TYPES[String(params['type'])];
    return type ? ok(importTemplate(type)) : fail('NOT_FOUND');
  },
  respond: (result) => {
    if (!result.ok) return problemResponse(result.error);
    const template = result.value as { fileName: string; content: string };
    return new Response(template.content, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${template.fileName}"`,
      },
    });
  },
});
