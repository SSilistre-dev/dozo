/**
 * Whether the speech server, rather than the browser's own recognizer, hears the caller: the
 * call check said it can (`serverDictation`) and the provider still transcribes. Web Speech in
 * a browser such as Chrome sends the voice to a cloud service, which an offline or private
 * setup must not depend on.
 */
export function serverHearsCaller(
  transcribe: boolean | undefined,
  serverDictation: boolean | undefined,
): boolean {
  return serverDictation === true && transcribe !== false;
}
