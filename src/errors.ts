// Player-facing error text. Errors carry only a code; the HTTP layer maps the
// code to fixed wording here, so no exception text ever reaches a response.

export type ErrorCode =
  | 'weary' | 'ward-mended' | 'nothing-to-mend' | 'mend-first' | 'gate-only' | 'test-first'
  | 'method' | 'content-type' | 'too-large' | 'bad-json' | 'unknown-room'
  | 'empty-message' | 'message-too-long';

export function publicMessage(code: ErrorCode): string {
  switch (code) {
    case 'weary': return 'The guardian has grown weary of you. Reset the room to try again.';
    case 'ward-mended': return 'The ward is mended. Use Test the ward to replay your attack.';
    case 'nothing-to-mend': return 'There is no exposed weakness to mend yet.';
    case 'mend-first': return 'Mend the ward before testing it.';
    case 'gate-only': return 'Only the Warden’s gate has a permission check.';
    case 'test-first': return 'Test the ward first; the permission check is for a replay without a tool call.';
    case 'method': return 'Method not allowed.';
    case 'content-type': return 'Requests must be application/json.';
    case 'too-large': return 'Request body too large.';
    case 'bad-json': return 'Invalid JSON.';
    case 'unknown-room': return 'Unknown room.';
    case 'empty-message': return 'Write something first.';
    case 'message-too-long': return 'Messages are limited to 1000 characters.';
    default: return 'Something went wrong in the archive. Please try again.';
  }
}
