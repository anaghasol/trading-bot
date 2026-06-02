import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase-server'
import { buildLearningContext } from '@/lib/learning'

/**
 * GET /api/learning
 * Returns the LearningContext Claude reads before each pick, plus the raw
 * lesson rows from tb_learnings for the Learning page journal.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()

  const [context, lessonsResult] = await Promise.all([
    buildLearningContext().catch(() => null),
    db.from('tb_learnings').select('*').order('created_at', { ascending: false }).limit(40),
  ])

  return NextResponse.json({
    context,
    lessons: lessonsResult.data ?? [],
  })
}
