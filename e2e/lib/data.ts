/** Every record a test creates starts with E2E, so it can be found and removed. */
export const RUN = process.env.E2E_RUN ?? new Date().toISOString().slice(5, 16).replace(/\D/g, '')
export const TENANT_NAME = 'E2E Testkrogen Åäö'
export const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'e2e-testkrogen'
/** SES mailbox simulator: accepted in the dev SES sandbox, reaches no person. */
export const mail = (tag: string) => `success+e2e-${tag}@simulator.amazonses.com`
/** PTS range reserved for fiction (070-1740605..699): never a real subscriber. */
export const PHONE = '+46 70 174 06 05'
/** Luhn-valid made-up org number. */
export const ORG_NUMBER = '5590000005'
