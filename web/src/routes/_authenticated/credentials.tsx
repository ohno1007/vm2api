import { createFileRoute } from '@tanstack/react-router'
import { CredentialsPage } from '@/features/credentials'

export const Route = createFileRoute('/_authenticated/credentials')({
  component: CredentialsPage,
})
