import type { UpdateBookDetailsInput } from './book-details.types';

import * as repo from './book-details.repository';

export function listBookDetails(projectUnitId: number) {
  return repo.list(projectUnitId);
}

export function updateBookDetails(
  projectUnitId: number,
  bookId: number,
  input: UpdateBookDetailsInput
) {
  return repo.update(projectUnitId, bookId, input);
}
