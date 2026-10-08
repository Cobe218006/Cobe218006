import { useState } from 'react';
import { getVault } from '../lib/store';
import { sha256Hex } from '../lib/crypto';
import { recordCredential } from '../lib/credentials';
import type { CredentialDomain } from '../lib/credentials';
import { pqAvailable, signPayload } from '../lib/pq';

interface Question {
  q: string;
  options: string[];
  correct: number;
}

interface QuizSet {
  id: string;
  label: string;
  domain: CredentialDomain;
  questions: Question[];
}

const QUIZZES: QuizSet[] = [
  {
    id: 'protocol-fundamentals-v1',
    label: 'Protocol fundamentals',
    domain: 'defi',
    questions: [
      {
        q: 'A smart contract function that transfers funds before updating internal balances is vulnerable to:',
        options: ['Front-running only', 'Reentrancy', 'Integer overflow only', 'Nothing, this is safe'],
        correct: 1,
      },
      {
        q: 'A "verifiable credential" is cryptographically verified by:',
        options: ["Trusting the issuer's website", "Checking the issuer's signature over the credential", 'Asking the holder nicely', 'It cannot be verified'],
        correct: 1,
      },
      {
        q: 'An on-chain anchor of a document hash proves:',
        options: ['The document is true', 'The document existed in that exact form at that time', 'The signer is a real, named person', 'The document is legally binding'],
        correct: 1,
      },
    ],
  },
  {
    id: 'ai-provenance-v1',
    label: 'AI output provenance',
    domain: 'ai',
    questions: [
      {
        q: 'An AI model returning the same citation twice in two different sessions proves:',
        options: ['The citation is permanently true', 'Only that it was returned under those two specific conditions', 'The source is authoritative', 'Nothing can be concluded'],
        correct: 1,
      },
      {
        q: 'C2PA-style content provenance primarily establishes:',
        options: ['That the content is factually accurate', 'A tamper-evident record of how content was produced or edited', 'That the creator is verified as a real person', 'Copyright ownership'],
        correct: 1,
      },
      {
        q: 'Recording a model’s "temperature" and seed alongside its output is useful because:',
        options: ['It makes the output deterministic forever', 'It documents conditions that affect reproducibility, without guaranteeing an identical rerun', 'It proves the output is correct', 'It is required by law'],
        correct: 1,
      },
    ],
  },
  {
    id: 'cryptography-basics-v1',
    label: 'Applied cryptography basics',
    domain: 'engineering',
    questions: [
      {
        q: 'Deterministic ECDSA signing (RFC 6979) exists to:',
        options: ['Make signatures faster', 'Avoid relying on a secure random number generator for the nonce', 'Make signatures smaller', 'Enable multi-signature wallets'],
        correct: 1,
      },
      {
        q: 'NIST’s ML-DSA (FIPS 204) is significant because it is:',
        options: ['Faster than ECDSA', 'Designed to remain secure against a quantum adversary', 'Smaller than ECDSA signatures', 'Only usable on specific hardware'],
        correct: 1,
      },
      {
        q: 'RFC 8785 (JSON Canonicalization Scheme) matters for signing JSON because:',
        options: ['It compresses the JSON', 'Two semantically-identical objects must hash to the same bytes for a signature over them to be reproducibly checkable', 'It encrypts the JSON', 'It is required by all browsers'],
        correct: 1,
      },
    ],
  },
];

const PASS_FRACTION = 0.75;

export default function Certify({ address }: { address: string }) {
  const [quizId, setQuizId] = useState(QUIZZES[0].id);
  const quiz = QUIZZES.find((q) => q.id === quizId)!;
  const [answers, setAnswers] = useState<(number | null)[]>(quiz.questions.map(() => null));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);

  function selectQuiz(id: string) {
    const next = QUIZZES.find((q) => q.id === id)!;
    setQuizId(id);
    setAnswers(next.questions.map(() => null));
    setSubmitted(false);
    setCredentialId(null);
    setErr(null);
  }

  const correctCount = answers.filter((a, i) => a === quiz.questions[i].correct).length;
  const score = correctCount / quiz.questions.length;
  const passed = score >= PASS_FRACTION;

  async function issue() {
    setBusy(true);
    setErr(null);
    try {
      const body = { skill: quiz.id, score, answeredAt: new Date().toISOString(), holder: address };
      const bodyJson = JSON.stringify(body);
      const hash = await sha256Hex(bodyJson);

      const vault = getVault();
      const signer = vault.getSigner();
      const pq = signer ? await pqAvailable() : false;
      const envelope = signer ? await signPayload(signer, new TextEncoder().encode(bodyJson), pq ? 'hybrid' : 'ecdsa') : null;

      const { proofId } = await vault.anchor(hash, `urn:credential:${quiz.id}`, `${quiz.label} (${Math.round(score * 100)}%)`);
      recordCredential({
        id: hash,
        type: 'AssessedSkillCredential',
        label: `${quiz.label} (${Math.round(score * 100)}%)`,
        domain: quiz.domain,
        issuedAt: Date.now(),
        status: 'active',
        humanReviewed: false,
        postQuantum: Boolean(envelope?.mldsa),
        proofId,
        raw: { body, proof: envelope },
      });
      setCredentialId(hash);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    setSubmitted(true);
  }

  return (
    <div className="card">
      <h2>Self-assessment</h2>
      <p className="muted">
        This is a <strong>self-graded</strong> client-side quiz, not a third-party or IBM-reviewed certification — no
        human or external authority checks these answers. It demonstrates the credential pattern (assess → sign →
        anchor → present), not a claim of verified expertise. A real deployment would plug a genuine review process
        (human grader, proctored exam, or an actually-verified external attestation) in at this exact point instead.
      </p>

      <div className="tabs">
        {QUIZZES.map((q) => (
          <button key={q.id} className={quizId === q.id ? 'active' : ''} onClick={() => selectQuiz(q.id)}>
            {q.label}
          </button>
        ))}
      </div>

      {quiz.questions.map((question, i) => (
        <fieldset key={i} disabled={submitted}>
          <legend>{question.q}</legend>
          {question.options.map((opt, j) => (
            <label key={j} className="radio-row">
              <input type="radio" name={`q${i}`} checked={answers[i] === j} onChange={() => setAnswers((prev) => prev.map((v, k) => (k === i ? j : v)))} />
              {opt}
            </label>
          ))}
        </fieldset>
      ))}

      {!submitted && (
        <button className="primary" onClick={submit} disabled={answers.some((a) => a === null)}>
          Submit
        </button>
      )}

      {submitted && (
        <div className={passed ? 'success' : 'error'}>
          <p>
            Score: {correctCount} / {quiz.questions.length} ({Math.round(score * 100)}%) —{' '}
            {passed ? 'Passed' : `Below the ${Math.round(PASS_FRACTION * 100)}% threshold`}
          </p>
          {passed && !credentialId && (
            <button onClick={issue} disabled={busy}>
              {busy ? 'Issuing…' : 'Issue my credential'}
            </button>
          )}
          {credentialId && <p className="small mono">Credential issued: {credentialId.slice(0, 18)}…</p>}
          {!passed && (
            <button
              onClick={() => {
                setSubmitted(false);
                setAnswers(quiz.questions.map(() => null));
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
