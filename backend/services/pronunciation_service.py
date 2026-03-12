# backend/services/pronunciation_service.py

import numpy as np
import librosa
import logging
from pathlib import Path
from typing import List, Dict, Tuple
import re

logger = logging.getLogger(__name__)

# ============================================================================
# CMUDICT LOADER
# ============================================================================

class CMUDictLoader:
    """Load and query CMU Pronouncing Dictionary"""
    
    def __init__(self):
        self.dict = {}
        self._load_dict()
    
    def _load_dict(self):
        """Load CMUDICT"""
        try:
            import cmudict
            self.dict = cmudict.dict()
            logger.info(f"✅ Loaded CMUDICT with {len(self.dict)} words")
        except ImportError:
            logger.error("❌ cmudict package not installed")
            raise
    
    def get_pronunciation(self, word: str) -> List[str]:
        """Get phoneme sequence for a word"""
        word = word.lower().strip()
        pron = self.dict.get(word)
        if pron:
            # Remove stress markers
            return [re.sub(r'[0-9]', '', p) for p in pron[0]]
        return []
    
    def sentence_to_phonemes(self, sentence: str) -> List[str]:
        """Convert sentence to phoneme sequence"""
        words = sentence.lower().split()
        all_phonemes = []
        
        for word in words:
            pron = self.get_pronunciation(word)
            if pron:
                all_phonemes.extend(pron)
            else:
                logger.warning(f"Word not in CMUDICT: {word}")
                all_phonemes.append('UNK')
        
        return all_phonemes


# ============================================================================
# WPSM MATRIX
# ============================================================================

class WPSM:
    """Weighted Phonemic Substitution Matrix"""
    
    def __init__(self):
        self.matrix = {}
        self._build_matrix()
    
    def _build_matrix(self):
        """Build WPSM from paper"""
        matrix_data = {
            # Vowels
            ('AA', 'AA'): 2.93, ('AA', 'AE'): 1.69, ('AA', 'AH'): 0.94,
            ('AE', 'AE'): 2.96, ('AE', 'AH'): 0.84,
            ('AH', 'AH'): 2.01, ('AO', 'AO'): 3.64,
            ('EH', 'EH'): 2.88, ('ER', 'ER'): 3.08,
            ('IH', 'IH'): 2.91, ('IH', 'IY'): 1.56,
            ('IY', 'IY'): 3.45, ('OW', 'OW'): 3.40,
            ('UH', 'UH'): 2.95, ('UW', 'UW'): 3.50,
            
            # Consonants
            ('P', 'P'): 3.43, ('P', 'B'): 1.23,
            ('B', 'B'): 3.43, ('T', 'T'): 3.43,
            ('T', 'D'): 1.89, ('D', 'D'): 3.38,
            ('K', 'K'): 3.40, ('K', 'G'): 1.18,
            ('G', 'G'): 3.22, ('F', 'F'): 3.11,
            ('F', 'V'): 1.43, ('V', 'V'): 3.07,
            ('S', 'S'): 3.21, ('S', 'Z'): 1.76,
            ('Z', 'Z'): 3.15, ('M', 'M'): 3.31,
            ('N', 'N'): 3.28, ('L', 'L'): 3.19,
            ('R', 'R'): 3.08, ('W', 'W'): 3.25,
        }
        
        # Make symmetric
        for (a, b), score in matrix_data.items():
            self.matrix[(a, b)] = score
            if a != b:
                self.matrix[(b, a)] = score
    
    def get_similarity(self, p1: str, p2: str) -> float:
        """Get similarity between phonemes"""
        if p1 == p2:
            return self.matrix.get((p1, p1), 3.0)
        
        score = self.matrix.get((p1, p2))
        if score is None:
            score = self.matrix.get((p2, p1))
        return score if score is not None else -1.0


# ============================================================================
# ALIGNMENT
# ============================================================================

class NeedlemanWunschAligner:
    """Global sequence alignment"""
    
    def __init__(self, wpsm: WPSM, gap_penalty: float = -0.73):
        self.wpsm = wpsm
        self.gap_penalty = gap_penalty
    
    def align(self, seq1: List[str], seq2: List[str]) -> Tuple[List[str], List[str], float]:
        """Align two phoneme sequences"""
        m, n = len(seq1), len(seq2)
        
        # Initialize
        score = np.zeros((m + 1, n + 1))
        trace = np.zeros((m + 1, n + 1), dtype=int)
        
        for i in range(1, m + 1):
            score[i][0] = score[i-1][0] + self.gap_penalty
            trace[i][0] = 1
        for j in range(1, n + 1):
            score[0][j] = score[0][j-1] + self.gap_penalty
            trace[0][j] = 2
        
        # Fill matrix
        for i in range(1, m + 1):
            for j in range(1, n + 1):
                diag = score[i-1][j-1] + self.wpsm.get_similarity(seq1[i-1], seq2[j-1])
                up = score[i-1][j] + self.gap_penalty
                left = score[i][j-1] + self.gap_penalty
                
                if diag >= up and diag >= left:
                    score[i][j] = diag
                    trace[i][j] = 0
                elif up >= left:
                    score[i][j] = up
                    trace[i][j] = 1
                else:
                    score[i][j] = left
                    trace[i][j] = 2
        
        # Traceback
        aligned1, aligned2 = [], []
        i, j = m, n
        
        while i > 0 or j > 0:
            if i > 0 and j > 0 and trace[i][j] == 0:
                aligned1.insert(0, seq1[i-1])
                aligned2.insert(0, seq2[j-1])
                i -= 1
                j -= 1
            elif i > 0 and trace[i][j] == 1:
                aligned1.insert(0, seq1[i-1])
                aligned2.insert(0, '-')
                i -= 1
            else:
                aligned1.insert(0, '-')
                aligned2.insert(0, seq2[j-1])
                j -= 1
        
        return aligned1, aligned2, score[m][n]


# ============================================================================
# METRICS
# ============================================================================

class PronunciationMetrics:
    """Calculate MSS and MIR"""
    
    def __init__(self, wpsm: WPSM):
        self.aligner = NeedlemanWunschAligner(wpsm)
        self.wpsm = wpsm
    
    def identity_score(self, phonemes: List[str]) -> float:
        """Score when comparing to itself"""
        _, _, score = self.aligner.align(phonemes, phonemes)
        return score
    
    def mss(self, spoken: List[str], reference: List[str]) -> float:
        """Mean Similarity Score"""
        _, _, score = self.aligner.align(spoken, reference)
        avg_len = (len(spoken) + len(reference)) / 2
        return score / avg_len if avg_len > 0 else 0
    
    def mir(self, spoken: List[str], reference: List[str]) -> float:
        """Mean Identity Ratio (%)"""
        _, _, sim_score = self.aligner.align(spoken, reference)
        id_score = self.identity_score(reference)
        return (sim_score / id_score * 100) if id_score > 0 else 0
    
    def detailed_analysis(self, spoken: List[str], reference: List[str]) -> Dict:
        """Complete analysis"""
        aligned_spoken, aligned_ref, score = self.aligner.align(spoken, reference)
        
        mss_val = self.mss(spoken, reference)
        mir_val = self.mir(spoken, reference)
        
        # Create alignment visualization
        errors = []
        for i, (s, r) in enumerate(zip(aligned_spoken, aligned_ref)):
            if s != r:
                errors.append({
                    'position': i,
                    'expected': r,
                    'spoken': s,
                    'similarity': self.wpsm.get_similarity(s, r) if s != '-' and r != '-' else -1.0
                })
        
        # Determine quality level
        if mir_val >= 95:
            quality = "excellent"
            feedback = "Native-like pronunciation! 🌟"
        elif mir_val >= 85:
            quality = "good"
            feedback = "Good pronunciation with minor accent. ✅"
        elif mir_val >= 70:
            quality = "fair"
            feedback = "Understandable but noticeable accent. 📍"
        elif mir_val >= 50:
            quality = "poor"
            feedback = "Difficult to understand. Keep practicing! ⚠️"
        else:
            quality = "very_poor"
            feedback = "Needs significant improvement. 💪"
        
        return {
            'mss': round(mss_val, 2),
            'mir': round(mir_val, 1),
            'quality': quality,
            'feedback': feedback,
            'errors': errors,
            'error_count': len(errors),
            'aligned_spoken': ' '.join(aligned_spoken),
            'aligned_reference': ' '.join(aligned_ref),
            'reference_phonemes': ' '.join(reference),
            'spoken_phonemes': ' '.join(spoken)
        }


# ============================================================================
# SIMPLIFIED FORCED ALIGNMENT (No external dependencies)
# ============================================================================

class SimpleAligner:
    """Simplified alignment without external tools"""
    
    def __init__(self, cmudict: CMUDictLoader):
        self.cmudict = cmudict
    
    def extract_phonemes_from_audio(self, audio_path: str, text: str) -> List[str]:
        """
        Simplified: Just return reference phonemes
        In production, use proper forced alignment (Gentle, MFA, etc.)
        """
        # For now, return reference phonemes
        # TODO: Implement actual forced alignment
        return self.cmudict.sentence_to_phonemes(text)


# ============================================================================
# MAIN SERVICE
# ============================================================================

class PronunciationService:
    """Main pronunciation analysis service"""
    
    def __init__(self):
        logger.info("🔧 Initializing Pronunciation Service...")
        
        self.cmudict = CMUDictLoader()
        self.wpsm = WPSM()
        self.metrics = PronunciationMetrics(self.wpsm)
        self.aligner = SimpleAligner(self.cmudict)
        
        logger.info("✅ Pronunciation Service ready")
    
    async def analyze_pronunciation(
        self,
        audio_path: str,
        expected_text: str
    ) -> Dict:
        """
        Analyze pronunciation from audio file
        
        Args:
            audio_path: Path to recorded audio (WAV)
            expected_text: What the user was supposed to say
            
        Returns:
            Analysis results with MIR score and feedback
        """
        try:
            logger.info(f"🎙️ Analyzing: {expected_text}")
            logger.info(f"   Audio: {audio_path}")
            
            # Get reference phonemes
            ref_phonemes = self.cmudict.sentence_to_phonemes(expected_text)
            logger.info(f"   Reference: {' '.join(ref_phonemes)}")
            
            # Extract spoken phonemes
            # TODO: Replace with actual forced alignment
            spoken_phonemes = self.aligner.extract_phonemes_from_audio(
                audio_path, 
                expected_text
            )
            logger.info(f"   Spoken: {' '.join(spoken_phonemes)}")
            
            # Calculate metrics
            analysis = self.metrics.detailed_analysis(spoken_phonemes, ref_phonemes)
            
            logger.info(f"✅ Analysis complete: MIR={analysis['mir']}%")
            
            return analysis
            
        except Exception as e:
            logger.error(f"❌ Analysis failed: {e}", exc_info=True)
            raise
    
    def get_word_pronunciation(self, word: str) -> Dict:
        """Get pronunciation for a single word"""
        phonemes = self.cmudict.get_pronunciation(word)
        
        return {
            'word': word,
            'phonemes': phonemes,
            'phoneme_string': ' '.join(phonemes) if phonemes else None,
            'found': len(phonemes) > 0
        }