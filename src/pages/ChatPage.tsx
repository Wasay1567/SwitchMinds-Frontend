import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, Settings, LogOut, History, X, ArrowDown, User, UserCheck2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/contexts/AuthContext';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useToast } from '@/hooks/use-toast';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { FileUpload } from '@/components/chat/FileUpload';
import { ModelSelector, fetchModels } from '@/components/chat/ModelSelector';
import { Model } from '@/types/model';

interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
  reasoning?: string;
  isReasoningComplete?: boolean;
  metadata?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface UploadedFile {
  file: File;
  type: 'image' | 'document';
  preview?: string;
}

// Helper function to parse JSON objects from stream
const parseJSONStream = (buffer: string): { parsed: any[], remaining: string } => {
  const parsed: any[] = [];
  let remaining = buffer;
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < remaining.length; i++) {
    const char = remaining[i];
    
    if (escaped) {
      escaped = false;
      continue;
    }
    
    if (char === '\\') {
      escaped = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (inString) continue;
    
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      
      if (depth === 0) {
        const jsonStr = remaining.substring(start, i + 1);
        try {
          const obj = JSON.parse(jsonStr);
          parsed.push(obj);
        } catch (e) {
          console.warn('Failed to parse JSON object:', jsonStr);
        }
        start = i + 1;
      }
    }
  }
  
  return {
    parsed,
    remaining: remaining.substring(start)
  };
};

export const ChatPage: React.FC = () => {
  const [selectedModel, setSelectedModel] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [sessionId] = useState(() => `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isUserScrolled, setIsUserScrolled] = useState(false);
  const [availableModels, setAvailableModels] = useState<Model[]>([]); // New state for models

  const { user, token, logout } = useAuth();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const scrollToBottom = (behavior: 'smooth' | 'auto' = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
    setShowScrollToBottom(false);
    setIsUserScrolled(false);
  };

  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    
    setShowScrollToBottom(!isNearBottom);
    setIsUserScrolled(scrollTop > 0 && !isNearBottom);
  };

  useEffect(() => {
    if (!isUserScrolled) {
      scrollToBottom();
    }
  }, [messages]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === 'assistant' && !lastMessage.isStreaming && !isLoading) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [messages, isLoading]);

  // Cleanup on unmount or page reload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const handleCancelRequest = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
      
      // Update the last message to show it was cancelled
      setMessages(prev => 
        prev.map((msg, index) => 
          index === prev.length - 1 && msg.role === 'assistant' && msg.isStreaming
            ? { 
                ...msg, 
                content: msg.content + '\n\n*Response was cancelled*',
                isStreaming: false,
                isReasoningComplete: true
              }
            : msg
        )
      );

      toast({
        title: "Request Cancelled",
        description: "The response generation has been stopped.",
      });
    }
  };

  const handleFileAdded = (newFiles: UploadedFile[]) => {
    setUploadedFiles(prev => [...prev, ...newFiles]);
  };

  const handleSendMessage = async () => {
    if ((!inputValue.trim() && uploadedFiles.length === 0) || isLoading) return;

    if (!token) {
      toast({
        title: "Authentication Error",
        description: "Please log in to send messages.",
        variant: "destructive",
      });
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      content: inputValue,
      role: 'user',
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    const currentInput = inputValue;
    const currentFiles = [...uploadedFiles];
    setInputValue('');
    setUploadedFiles([]);
    setIsLoading(true);
    setIsUserScrolled(false);

    const aiMessageId = (Date.now() + 1).toString();
    const selectedModelData = availableModels.find(m => m.id === selectedModel);
    const isReasoningModel = selectedModelData?.isReasoning || false;
    
    const aiMessage: Message = {
      id: aiMessageId,
      content: '',
      role: 'assistant',
      timestamp: new Date(),
      isStreaming: true,
      reasoning: isReasoningModel ? '' : undefined,
      isReasoningComplete: false,
    };

    setMessages(prev => [...prev, aiMessage]);

    try {
      const formData = new FormData();
      formData.append('session_id', sessionId);
      formData.append('question', currentInput);
      formData.append('provider', selectedModelData?.provider || 'google');
      formData.append('model', selectedModel);
      formData.append('our_image_processing_algo', 'false');
      formData.append('document_semantic_search', 'false');

      currentFiles.forEach((uploadedFile) => {
        if (uploadedFile.type === 'image') {
          formData.append('upload_image', uploadedFile.file);
        } else {
          formData.append('upload_document', uploadedFile.file);
        }
      });

      const API_BASE_URL = 'http://localhost:8000';
      abortControllerRef.current = new AbortController();

      const response = await fetch(`${API_BASE_URL}/chat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulatedContent = '';
      let accumulatedReasoning = '';
      let isReasoningPhase = isReasoningModel;
      let buffer = '';

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            
            const { parsed, remaining } = parseJSONStream(buffer);
            buffer = remaining;
            
            for (const parsedChunk of parsed) {
              if (parsedChunk.type === 'reasoning') {
                accumulatedReasoning += parsedChunk.data;
                setMessages(prev => 
                  prev.map(msg => 
                    msg.id === aiMessageId 
                      ? { ...msg, reasoning: accumulatedReasoning }
                      : msg
                  )
                );
              } else if (parsedChunk.type === 'content') {
                if (isReasoningPhase) {
                  isReasoningPhase = false;
                  setMessages(prev => 
                    prev.map(msg => 
                      msg.id === aiMessageId 
                        ? { ...msg, isReasoningComplete: true }
                        : msg
                    )
                  );
                }
                accumulatedContent += parsedChunk.data;
                setMessages(prev => 
                  prev.map(msg => 
                    msg.id === aiMessageId 
                      ? { ...msg, content: accumulatedContent }
                      : msg
                  )
                );
              } else if (parsedChunk.type === 'metadata') {
                setMessages(prev => 
                  prev.map(msg => 
                    msg.id === aiMessageId 
                      ? { ...msg, metadata: parsedChunk.data }
                      : msg
                  )
                );
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }

      setMessages(prev => 
        prev.map(msg => 
          msg.id === aiMessageId 
            ? { ...msg, isStreaming: false, isReasoningComplete: true }
            : msg
        )
      );

    } catch (error) {
      console.error('Error sending message:', error);
      
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      
      let errorMessage = "Failed to send message. Please try again.";
      if (error instanceof Error) {
        if (error.message.includes('Failed to fetch')) {
          errorMessage = "Unable to connect to server. Please check your connection.";
        } else if (error.message.includes('401')) {
          errorMessage = "Authentication failed. Please log in again.";
        } else if (error.message.includes('403')) {
          errorMessage = "Access denied. Please check your permissions.";
        } else if (error.message.includes('404')) {
          errorMessage = "Chat endpoint not found. Please check server configuration.";
        } else if (error.message.includes('500')) {
          errorMessage = "Server error. Please try again later.";
        }
      }
      
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
      
      setMessages(prev => 
        prev.map(msg => 
          msg.id === aiMessageId 
            ? { 
                ...msg, 
                content: "Sorry, I encountered an error while processing your request. Please try again.",
                isStreaming: false
              }
            : msg
        )
      );
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleLogout = () => {
    logout();
    toast({
      title: "Logged out",
      description: "You have been successfully logged out.",
    });
  };

  const handleSettings = () => {
    toast({
      title: "Settings",
      description: "Settings page coming soon!",
    });
  };

  const handleChatHistory = () => {
    toast({
      title: "Chat History",
      description: "Chat history feature coming soon!",
    });
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 flex flex-col font-sans">

      {/* Chat Container */}
      <div className="flex-1 w-full max-w-4xl mx-auto px-4 flex flex-col relative">
        {/* Messages Area */}
        <div 
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto py-6 space-y-4"
          style={{ minHeight: 0 }}
        >
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full min-h-[400px]">
              <div className="text-center max-w-md">
                <Sparkles className="h-12 w-12 text-green-600 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-gray-900 mb-2">How can I help you today?</h3>
                <p className="text-gray-600">
                  Start a conversation with {availableModels.find(m => m.id === selectedModel)?.name}.
                </p>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <ChatMessage 
                key={message.id} 
                message={message} 
                username={user?.username} 
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Scroll to Bottom Button */}
        {showScrollToBottom && (
          <Button
            onClick={() => scrollToBottom()}
            className="fixed bottom-24 right-8 h-10 w-10 rounded-full bg-white border shadow-lg hover:shadow-xl z-10"
            size="icon"
            variant="outline"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        )}

        {/* Cancel Button during streaming */}
        {isLoading && (
          <div className="flex justify-center py-4">
            <Button
              onClick={handleCancelRequest}
              variant="outline"
              size="sm"
              className="flex items-center gap-2 text-red-600 border-red-200 hover:bg-red-50"
            >
              <X className="h-4 w-4" />
              Stop generating
            </Button>
          </div>
        )}

        {/* Input Area */}
        <div className="py-4 sticky bottom-0 bg-gray-50">
          <div className="bg-white rounded-xl border shadow-sm p-3">
            <div className="flex items-end gap-3">
              <FileUpload 
                uploadedFiles={uploadedFiles}
                setUploadedFiles={setUploadedFiles}
                isLoading={isLoading}
                onFileAdded={handleFileAdded}
              />
              
              <div className="flex-1 min-w-0 relative">
                <Textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Message Syncmind..."
                  className="min-h-[24px] max-h-32 resize-none border-0 p-0 focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
                  disabled={isLoading}
                  rows={1}
                  style={{ 
                    height: 'auto',
                    lineHeight: '1.5'
                  }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = 'auto';
                    target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
                  }}
                />
              </div>
              
              <Button
                onClick={handleSendMessage}
                disabled={(!inputValue.trim() && uploadedFiles.length === 0) || isLoading}
                size="icon"
                className="h-8 w-8 bg-gray-900 hover:bg-gray-800 rounded-lg shrink-0"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatPage;
