import { NextResponse } from 'next/server';
import { getAvailableTickers } from '@/lib/dataFetcher';

export async function GET() {
    return NextResponse.json(getAvailableTickers());
}
