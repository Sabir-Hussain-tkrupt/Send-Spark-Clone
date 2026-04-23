function normalizeKey(input) {
  return String(input || '')
    .trim()
    .replace(/[\s_-]+/g, '')
    .toLowerCase()
}

export function createEmptyContact() {
  return {
    id: crypto.randomUUID(),
    firstName: '',
    lastName: '',
    email: '',
    companyName: '',
    customField: '',
    backgroundUrl: '',
  }
}

export function normalizeContact(contact) {
  return {
    id: contact.id || crypto.randomUUID(),
    firstName: String(contact.firstName || '').trim(),
    lastName: String(contact.lastName || '').trim(),
    email: String(contact.email || '').trim(),
    companyName: String(contact.companyName || '').trim(),
    customField: String(contact.customField || '').trim(),
    backgroundUrl: String(contact.backgroundUrl || '').trim(),
  }
}

function resolveValue(token, context) {
  const normalizedToken = normalizeKey(token)

  if (!normalizedToken) {
    return ''
  }

  const entries = Object.entries(context)
  for (const [rawKey, rawValue] of entries) {
    if (normalizeKey(rawKey) === normalizedToken) {
      return rawValue
    }
  }

  if (normalizedToken === 'firstname') return context.firstName
  if (normalizedToken === 'lastname') return context.lastName
  if (normalizedToken === 'email') return context.email
  if (normalizedToken === 'companyname') return context.companyName
  if (normalizedToken === 'customfield') return context.customField

  return ''
}

export function applyTemplate(template, contact) {
  const safeTemplate = String(template || '')
  const context = normalizeContact(contact)

  const replaced = safeTemplate.replace(/{{\s*([^}|]+?)\s*(?:\|\s*([^}]+?)\s*)?}}/g, (_, token, fallback) => {
    const value = resolveValue(token, context)
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim()
    }

    return fallback ? String(fallback).trim() : ''
  })

  // Collapse any double-spaces and stray punctuation gaps left by empty tokens
  return replaced.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,!.?])/g, '$1').trim()
}

export function replaceKeywordWithFirstName(text, keyword, firstName) {
  const safeText = String(text || '')
  const safeKeyword = String(keyword || '').trim()
  const fallbackName = String(firstName || '').trim() || 'there'

  if (!safeKeyword) {
    return safeText
  }

  const escaped = safeKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${escaped}\\b`, 'gi')
  return safeText.replace(re, fallbackName)
}

export function keywordExists(text, keyword) {
  const safeText = String(text || '')
  const safeKeyword = String(keyword || '').trim()

  if (!safeKeyword) {
    return false
  }

  const escaped = safeKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${escaped}\\b`, 'i')
  return re.test(safeText)
}

function editDistance(a, b) {
  const left = String(a || '')
  const right = String(b || '')

  if (!left) return right.length
  if (!right) return left.length

  const dp = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0))

  for (let i = 0; i <= left.length; i += 1) dp[i][0] = i
  for (let j = 0; j <= right.length; j += 1) dp[0][j] = j

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }

  return dp[left.length][right.length]
}

export function keywordExistsFuzzy(text, keyword) {
  const source = String(text || '').toLowerCase().trim()
  const target = String(keyword || '').toLowerCase().trim()

  if (!source || !target) {
    return false
  }

  if (keywordExists(source, target)) {
    return true
  }

  const compact = source.replace(/[^a-z0-9]/g, '')
  if (compact.includes(target)) {
    return true
  }

  const tokens = source.split(/[^a-z0-9]+/).filter(Boolean)

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (Math.abs(token.length - target.length) <= 2 && editDistance(token, target) <= 2) {
      return true
    }

    if (i < tokens.length - 1) {
      const merged = `${tokens[i]}${tokens[i + 1]}`
      if (Math.abs(merged.length - target.length) <= 2 && editDistance(merged, target) <= 2) {
        return true
      }
    }
  }

  return false
}
