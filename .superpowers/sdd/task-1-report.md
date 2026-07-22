# Task 1 Report: Shared Upstage Enhanced request contract

## Implementation

- Added the exported `DocumentParseOptions` type with `mimeType`, `pageNumber`, and optional `signal`.
- Updated `UpstageDocumentParser.parse()` to create an Enhanced multipart request using `ocr=force`, `mode=enhanced`, `base64_encoding=["footnote"]`, and `output_formats=["html"]`.
- The document blob now takes its MIME type from the parse options, allowing a rendered PNG page to be uploaded as `image/png`.
- Normalized `raw.elements ?? []` and returned non-secret audit metadata in `requestConfig`. It includes the model, fixed request fields, MIME type, and page number; it deliberately excludes the API key and authorization header.
- `parse()` requires `DocumentParseOptions`; the current legacy pipeline explicitly supplies its temporary PDF/page-one options until Task 3 replaces it with rendered PNG pages.

## Files changed

- `src/server/providers/upstage-document.ts`
- `src/server/documents/pipeline.ts`
- `tests/unit/providers/document.test.ts`

## RED

Command:

```text
npm test -- tests/unit/providers/document.test.ts
```

Relevant output:

```text
FAIL  tests/unit/providers/document.test.ts > sends the Upstage Enhanced multipart request for a PNG page
AssertionError: expected 'auto' to be 'force'
Expected: "force"
Received: "auto"
```

The rejected promise was reported as a `ProviderError` because the shared fetch helper correctly wraps the test assertion thrown inside the mocked fetch implementation.

## GREEN

Command:

```text
npm test -- tests/unit/providers/document.test.ts
```

Relevant output:

```text
Test Files  1 passed (1)
Tests  2 passed (2)
```

Additional verification:

```text
npm run typecheck
```

completed successfully, and `git diff --check` reported no whitespace errors.

## Full suite

Command:

```text
npm test
```

Result:

```text
Test Files  10 passed (10)
Tests  30 passed (30)
```

## Self-review

- The multipart contract test inspects the real `FormData`, including all fixed Enhanced fields, configured model, and `image/png` blob type.
- Request metadata contains no API key or authorization value.
- The response contract contains HTML, normalized elements, raw response, request ID, model, and request configuration.
- Typecheck and focused/full unit tests pass.

## Review fix verification

The review found that parse options were optional. The adapter-level PDF fallback was removed, `DocumentParseOptions` is now required, and the sole legacy pipeline caller explicitly passes `{ mimeType: 'application/pdf', pageNumber: 1 }` as a temporary bridge to Task 3.

Command:

```text
npm test -- tests/unit/providers/document.test.ts
```

Output:

```text
Test Files  1 passed (1)
Tests  2 passed (2)
```

Command:

```text
npm run typecheck
```

Output:

```text
> edubench@0.1.0 typecheck
> tsc --noEmit
```

Command:

```text
git diff --check
```

Output: no diff errors (Git emitted only line-ending warnings for the modified files).
