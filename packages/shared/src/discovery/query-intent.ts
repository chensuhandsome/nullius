import { z } from 'zod';

export const DiscoveryQueryIntentSchema = z.enum([
  'known_item',
  'keyword_search',
  'semantic_search',
  'citation_expansion',
  'fulltext_search',
]);

export type DiscoveryQueryIntent = z.infer<typeof DiscoveryQueryIntentSchema>;
